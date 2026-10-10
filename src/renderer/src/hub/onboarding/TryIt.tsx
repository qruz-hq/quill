import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, m, type Variants } from 'motion/react'
import { Icon } from '../../shared/icons'
import { Button, Keycap } from '../../shared/ui'
import { EASE, tokenize, useExitInert, useReduceMotion } from '../../shared/motion'
import { Keycaps, pretty } from '../settings/shared'
import { SpectrumBars } from '../SpectrumBars'
import { TRY_IT, Trail } from './trail'

/* "Tile / Try it" on the Done screen (design.pen: Prompt MbPuc, Listening
   PA4Z8, Speaking v4K5K0, Result w2aTS, Nothing heard vRyJd, Mic problem
   qOVI5; motion: storyboard H, faHiK). While it is up, dictations are
   practice: they are heard and shown here, and nothing is pasted. */

type View =
  | { kind: 'prompt' }
  /** `then`: the dictation is over; the words still waiting come out, then this view follows. */
  | { kind: 'live'; n: number; then?: View }
  | { kind: 'result'; text: string }
  | { kind: 'empty' }
  | { kind: 'mic' }

/** A release that neither transcribes nor reports back within this (ms) was a stray press. */
const STRAY_MS = 1500
/** After the pipeline goes idle, the result may still be on its way for this long (ms). */
const RESULT_GRACE_MS = 600
/** If the last words never report back, the result shows anyway after this (ms). */
const FLUSH_BACKSTOP_MS = 600
/** Nothing waits on a result longer than this (ms). */
const RESULT_BACKSTOP_MS = 30_000

export function TryIt({ holdKey, toggle, onMicSettings }: {
  /** The hold-to-talk key's cap ("fn"), or undefined when only the toggle shortcut is set. */
  holdKey?: string
  toggle: string
  onMicSettings: () => void
}): React.JSX.Element {
  const reduced = useReduceMotion()
  const [view, setView] = useState<View>({ kind: 'prompt' })
  const viewRef = useRef(view)
  viewRef.current = view

  useEffect(() => {
    const d = window.flow.dictation
    d.setPractice(true)
    let n = 0
    let busy = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const wait = (ms: number): void => {
      clearTimeout(timer)
      timer = setTimeout(() => { if (viewRef.current.kind === 'live') setView({ kind: 'prompt' }) }, ms)
    }
    const offs = [
      d.onState((s) => {
        if (s === 'recording') { clearTimeout(timer); busy = false; setView({ kind: 'live', n: ++n }) }
        else if (viewRef.current.kind === 'live') wait(busy ? RESULT_BACKSTOP_MS : STRAY_MS)
      }),
      d.onStage((s) => {
        if (viewRef.current.kind !== 'live') return
        if (s === 'idle') { if (busy) wait(RESULT_GRACE_MS) }
        else { busy = true; wait(RESULT_BACKSTOP_MS) }
      }),
      d.onPracticeResult((r) => {
        clearTimeout(timer)
        const next: View = 'text' in r ? (r.text.trim() ? { kind: 'result', text: r.text.trim() } : { kind: 'empty' })
          : 'error' in r && r.kind === 'mic' ? { kind: 'mic' } : { kind: 'empty' }
        const cur = viewRef.current
        // Words may still be waiting their turn: they come out first (Live calls back).
        if (cur.kind === 'live' && next.kind === 'result') {
          setView({ ...cur, then: next })
          timer = setTimeout(() => setView((v) => (v.kind === 'live' && v.then ? v.then : v)), FLUSH_BACKSTOP_MS)
        } else setView(next)
      })
    ]
    return () => { clearTimeout(timer); offs.forEach((off) => off()); d.setPractice(false) }
  }, [])

  const swap = useMemo<Variants>(() => {
    const d = reduced ? 0 : TRY_IT.crossFade
    return {
      initial: { opacity: reduced ? 1 : 0 },
      animate: { opacity: 1, transition: { duration: d, ease: [...EASE.out] } },
      exit: { opacity: 0, transition: { duration: d, ease: [...EASE.exit] } }
    }
  }, [reduced])

  const said = view.kind === 'live' ? 'Listening'
    : view.kind === 'result' ? `That’s it: ${view.text}`
      : view.kind === 'empty' ? 'Didn’t catch that.'
        : view.kind === 'mic' ? 'The microphone didn’t open.' : ''

  return (
    <>
      <AnimatePresence mode="popLayout" initial={false}>
        {view.kind === 'prompt' && (
          <Stage key="prompt" variants={swap}>
            <span className="ob-mono">TRY IT</span>
            <div className="ob-try__hold">
              {holdKey ? (
                <>
                  <span className="ob-try__word">Hold</span>
                  <Keycap className="ob-try__key">{holdKey}</Keycap>
                  <span className="ob-try__word">and say hello.</span>
                </>
              ) : (
                <>
                  <span className="ob-try__word">Press</span>
                  <Keycaps accel={toggle} className="ob-try__key" />
                  <span className="ob-try__word">and say hello.</span>
                </>
              )}
            </div>
            <p className="ob-try__hint">
              {holdKey
                ? `Let go and it lands wherever your cursor is. ${pretty(toggle)} starts and stops hands-free.`
                : 'Press it again and the text lands wherever your cursor is.'}
            </p>
          </Stage>
        )}
        {view.kind === 'live' && (
          <Live
            key={`live${view.n}`}
            variants={swap}
            ending={!!view.then}
            onDrained={() => setView((v) => (v.kind === 'live' && v.then ? v.then : v))}
          />
        )}
        {view.kind === 'result' && (
          <Stage key="result" variants={swap}>
            <div className="ob-try__label ob-try__label--check">
              <Icon name="check" size={16} className="ob-try__check" />
              <span className="ob-mono">THAT’S IT</span>
            </div>
            <Sentence text={view.text} />
          </Stage>
        )}
        {view.kind === 'empty' && (
          <Stage key="empty" variants={swap}>
            <span className="ob-mono">TRY IT</span>
            <p className="ob-try__title">Didn’t catch that.</p>
            <p className="ob-try__hint">
              {holdKey ? 'Hold the key and speak, then let go.' : `Press ${pretty(toggle)}, speak, then press it again.`}
            </p>
          </Stage>
        )}
        {view.kind === 'mic' && (
          <Stage key="mic" variants={swap}>
            <Icon name="warning" size={20} className="ob-try__warn" />
            <p className="ob-try__title">The microphone didn’t open.</p>
            <p className="ob-try__hint">Check the input in Settings.</p>
            <Button variant="ghost" onClick={onMicSettings}>Open Dictation settings</Button>
          </Stage>
        )}
      </AnimatePresence>
      <span className="m-sr-only" role="status" aria-live="polite">{said}</span>
    </>
  )
}

/** One state of the tile. It carries the tile's own column (gap 18, centred) so two can cross-fade. */
function Stage({ variants, children, ref }: {
  variants: Variants; children: ReactNode; ref?: React.Ref<HTMLDivElement>
}): React.JSX.Element {
  const inert = useExitInert()
  return (
    <m.div
      ref={ref}
      className="ob-try__stage"
      inert={inert.inert}
      style={inert.style}
      variants={variants}
      initial="initial"
      animate="animate"
      exit="exit"
    >
      {children}
    </m.div>
  )
}

/** Listening (PA4Z8), then Speaking (v4K5K0) from the first word heard. */
function Live({ variants, ending, onDrained, ref }: {
  variants: Variants
  /** The result is in: let the waiting words out, then say so. */
  ending: boolean; onDrained: () => void
  ref?: React.Ref<HTMLDivElement>
}): React.JSX.Element {
  const [speaking, setSpeaking] = useState(false)
  const words = useRef<HTMLDivElement>(null)
  const trail = useRef<Trail | null>(null)
  const latest = useRef('')

  useEffect(() => window.flow.dictation.onPartial((text) => {
    if (!tokenize(text).length) return
    latest.current = text
    if (trail.current) trail.current.partial(text)
    else setSpeaking(true)
  }), [])

  // The words block exists from the first word on; that partial is fed once it does.
  useLayoutEffect(() => {
    if (!speaking || !words.current) return
    const t = new Trail(words.current)
    trail.current = t
    t.partial(latest.current)
    return () => { trail.current = null; t.destroy() }
  }, [speaking])

  useEffect(() => {
    if (!ending) return
    if (trail.current) trail.current.flush(onDrained)
    else onDrained()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ending])

  return (
    <Stage ref={ref} variants={variants}>
      <div className="ob-try__label">
        <span className="ob-try__dot" aria-hidden />
        <span className="ob-mono">LISTENING</span>
      </div>
      {speaking && <div key="words" ref={words} className="ob-try__words" aria-hidden />}
      <SpectrumBars key="spectrum" className="ob-try__spectrum" barClassName="ob-try__bar" />
      {!speaking && <p key="hint" className="ob-try__hint">Say anything.</p>}
    </Stage>
  )
}

/** "Sentence" (LQA27). A long one is cut to the lines the tile has room for, with an ellipsis. */
function Sentence({ text }: { text: string }): React.JSX.Element {
  const el = useRef<HTMLParagraphElement>(null)
  useLayoutEffect(() => {
    const p = el.current
    const stage = p?.parentElement
    const tile = stage?.parentElement
    if (!p || !stage || !tile) return
    const fit = (): void => {
      const cs = getComputedStyle(tile)
      const room = tile.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)
      const others = stage.offsetHeight - p.offsetHeight
      const line = parseFloat(getComputedStyle(p).lineHeight) || p.offsetHeight
      p.style.setProperty('--lines', String(Math.max(1, Math.floor((room - others) / line))))
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(tile)
    return () => ro.disconnect()
  }, [text])
  return <p ref={el} className="ob-try__sentence" title={text}>{text}</p>
}
