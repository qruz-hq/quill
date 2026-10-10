/**
 * Dev-only Motion Lab: exercises the motion foundation in isolation and
 * exposes `window.__lab` for a Playwright harness (streaming, reduced motion,
 * frame timing). Served at /motion-lab.html by the renderer dev server; never
 * part of a production build.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, LayoutGroup, m } from 'motion/react'
import { BlurWords } from '../BlurWords'
import { BlurStream, StreamViewport, type BlurStreamHandle } from '../BlurStream'
import { BlurNumber, formatTimer } from '../BlurNumber'
import { Indicator, RealHeight, RealWidth } from '../MorphContainer'
import { popover, press, toast } from '../presets'
import { filterBudget } from '../filterBudget'
import { useReduceMotion, setReducedMotionOverride } from '../MotionProvider'
import { FLOWBAR, HOLD } from '../tokens'

/* A ~40-word dictation delivered as full running-text partials, with one
   substitution ("meat" → "meet"), one deletion ("the the" → "the") and a
   casing/punctuation fix, like the local helper re-decoding the buffer. */
const PARTIALS = [
  'okay so',
  'okay so I wanted to',
  'okay so I wanted to meat you',
  'okay so I wanted to meet you at the the',
  'okay so I wanted to meet you at the cafe on',
  'Okay, so I wanted to meet you at the cafe on Friday morning',
  'Okay, so I wanted to meet you at the cafe on Friday morning to talk through',
  'Okay, so I wanted to meet you at the cafe on Friday morning to talk through the launch plan',
  'Okay, so I wanted to meet you at the cafe on Friday morning to talk through the launch plan and the motion spec',
  'Okay, so I wanted to meet you at the cafe on Friday morning to talk through the launch plan and the motion spec before we share it with',
  'Okay, so I wanted to meet you at the cafe on Friday morning to talk through the launch plan and the motion spec before we share it with the whole team next week and get feedback on the exact timing.'
]

interface FrameStats {
  frames: number; avg: number; p95: number; max: number; over17: number; over33: number
  longTasks: number; maxFilters: number; maxAnimations: number; durationMs: number
}

declare global {
  interface Window { __lab?: Record<string, unknown> }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function filterCount(): number {
  let n = 0
  document.querySelectorAll('.bw-word, .bw-unit, .bw-tok, .bn-glyph').forEach((el) => {
    if (getComputedStyle(el).filter !== 'none') n++
  })
  return n
}

export default function MotionLab(): React.JSX.Element {
  const reduced = useReduceMotion()
  const [partial, setPartial] = useState('')
  const [final, setFinal] = useState(false)
  const [streamKey, setStreamKey] = useState(0)
  const [headline, setHeadline] = useState(0)
  const [headlineKey, setHeadlineKey] = useState(0)
  const [count, setCount] = useState(9_998)
  const [seconds, setSeconds] = useState(0)
  const [label, setLabel] = useState(0)
  const [nav, setNav] = useState(0)
  const [open, setOpen] = useState(false)
  const [banner, setBanner] = useState(false)
  const [toastN, setToastN] = useState<number | null>(null)
  const streamRef = useRef<BlurStreamHandle>(null)

  const runStream = useCallback(async (interval = 300) => {
    setFinal(false); setPartial(''); setStreamKey((k) => k + 1)
    await sleep(50)
    for (const p of PARTIALS) { setPartial(p); await sleep(interval) }
    setFinal(true)
    await sleep(400)
  }, [])

  // Recording timer (subtle digits).
  useEffect(() => {
    const t = setInterval(() => setSeconds((s) => s + 1), 1000)
    return () => clearInterval(t)
  }, [])

  // Playwright API.
  useEffect(() => {
    const measure = async (task: () => Promise<unknown>, sampleFilters = false): Promise<FrameStats> => {
      const deltas: number[] = []
      let maxFilters = 0, maxAnimations = 0, longTasks = 0
      let po: PerformanceObserver | null = null
      try {
        po = new PerformanceObserver((l) => { longTasks += l.getEntries().filter((e) => e.duration > 50).length })
        po.observe({ type: 'longtask', buffered: false })
      } catch { /* unsupported */ }
      let running = true
      let last = performance.now()
      const t0 = last
      const loop = (now: number): void => {
        deltas.push(now - last); last = now
        if (sampleFilters) {
          maxFilters = Math.max(maxFilters, filterCount())
          maxAnimations = Math.max(maxAnimations, document.getAnimations().length)
        }
        if (running) requestAnimationFrame(loop)
      }
      requestAnimationFrame((now) => { last = now; requestAnimationFrame(loop) })
      await task()
      running = false
      po?.disconnect()
      const sorted = [...deltas].sort((a, b) => a - b)
      const avg = deltas.reduce((a, b) => a + b, 0) / Math.max(1, deltas.length)
      return {
        frames: deltas.length,
        avg: +avg.toFixed(2),
        p95: +(sorted[Math.floor(sorted.length * 0.95)] ?? 0).toFixed(2),
        max: +(sorted[sorted.length - 1] ?? 0).toFixed(2),
        over17: deltas.filter((d) => d > 17.5).length,
        over33: deltas.filter((d) => d > 34).length,
        longTasks, maxFilters, maxAnimations,
        durationMs: Math.round(performance.now() - t0)
      }
    }
    window.__lab = {
      runStream,
      measure: (interval = 300, sampleFilters = false) => measure(() => runStream(interval), sampleFilters),
      filterCount,
      animations: () => document.getAnimations().length,
      budgetInUse: () => filterBudget.inUse,
      words: () => Array.from(document.querySelectorAll('[data-lab="stream"] .bw-word')).map((el) => el.textContent),
      streamText: () => document.querySelector('[data-lab="stream"]')?.textContent ?? '',
      streamSpans: () => document.querySelectorAll('[data-lab="stream"] .bw-word').length,
      nodeFor: (word: string) => {
        const el = Array.from(document.querySelectorAll('[data-lab="stream"] .bw-word')).find((e) => e.textContent === word)
        return el ? ((el as HTMLElement).dataset.labId ||= String(Math.random())) : null
      },
      setPartial, setFinal,
      swapHeadline: () => setHeadline((h) => h + 1),
      swapLabel: () => setLabel((l) => l + 1),
      setNav,
      /** Remount both streams with `text` already present (the catch-up path). */
      remountStream: (text: string) => { setFinal(false); setPartial(text); setStreamKey((k) => k + 1) },
      replayHeadline: () => setHeadlineKey((k) => k + 1),
      bump: (d: number) => setCount((c) => c + d),
      setReduced: (v: boolean | null) => setReducedMotionOverride(v),
      settle: () => streamRef.current?.settle()
    }
  }, [runStream])

  const headlines = [
    { parts: ['Hold', { node: <kbd style={kbd}>fn</kbd>, text: 'fn' }, 'to talk.'] },
    { parts: ["You're set."] },
    { parts: ['Two switches, then talk.'] }
  ]
  const labels = ['TRANSCRIBING', 'POLISHING', 'LISTENING']

  return (
    <div style={page}>
      <header style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 24 }}>
        <strong style={{ letterSpacing: 0.2 }}>Motion Lab</strong>
        <span style={chip} data-lab="reduced">{reduced ? 'Reduce Motion: ON (instant)' : 'Reduce Motion: off'}</span>
        <span style={{ ...chip, opacity: 0.7 }}>filters in use: <LiveBudget /></span>
      </header>

      <section style={card}>
        <div style={eyebrow}>headline · per word</div>
        <BlurWords
          key={headlineKey}
          as="h1"
          variant="headline"
          parts={headlines[headline % headlines.length].parts}
          style={{ fontSize: 44, lineHeight: 1.1, margin: '8px 0 12px', fontWeight: 600 }}
        />
        <div style={row}>
          <button style={btn} onClick={() => setHeadlineKey((k) => k + 1)}>Replay</button>
          <button style={btn} onClick={() => setHeadline((h) => h + 1)}>Swap</button>
        </div>
      </section>

      <section style={card}>
        <div style={eyebrow}>stream · partials diff (new words blur in, corrections re-blur, deletions blur out)</div>
        <div style={{ ...barCard }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <span data-lab="label"><BlurWords variant="label" text={labels[label % labels.length]} style={headLabel} animateWidth /></span>
            <BlurNumber value={seconds} format={formatTimer} size="subtle" style={headLabel} />
          </div>
          <StreamViewport height={2 * 20 + 8}>
            <BlurStream key={`card${streamKey}`} text={partial} final={final} catchUpStart={0.12} ariaHidden style={{ fontSize: 15, lineHeight: '20px' }} />
          </StreamViewport>
        </div>
        <div data-lab="stream" style={{ fontSize: 22, lineHeight: 1.4, minHeight: 96, marginTop: 16, maxWidth: 560 }}>
          <BlurStream key={streamKey} ref={streamRef} text={partial} final={final} />
        </div>
        <div style={row}>
          <button style={btn} onClick={() => void runStream(300)}>Stream (300 ms)</button>
          <button style={btn} onClick={() => void runStream(1500)}>Stream (1.5 s)</button>
          <button style={btn} onClick={() => setLabel((l) => l + 1)}>Label swap</button>
          <button style={btn} onClick={() => streamRef.current?.settle()}>Settle</button>
        </div>
      </section>

      <section style={card}>
        <div style={eyebrow}>numbers · digit blur-swap</div>
        <div style={{ fontSize: 48, fontWeight: 600, lineHeight: 1.1 }}>
          <BlurNumber value={count} />
        </div>
        <div style={row}>
          <button style={btn} onClick={() => setCount((c) => c + 1)}>+1</button>
          <button style={btn} onClick={() => setCount((c) => c - 1)}>−1</button>
          <button style={btn} onClick={() => setCount((c) => c + 137)}>+137</button>
          <button style={btn} onClick={() => setCount((c) => (c >= 10_000 ? 999 : 10_000))}>width</button>
        </div>
      </section>

      <section style={card}>
        <div style={eyebrow}>morph · indicator, popover, real height, toast</div>
        <LayoutGroup id="lab-nav">
          <nav style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
            {['Dictation', 'Snippets', 'Transforms', 'Settings'].map((t, i) => (
              <m.button key={t} {...press('button')} onClick={() => setNav(i)} style={{ ...navBtn, color: nav === i ? 'var(--lab-fg)' : 'var(--lab-fg-2)' }}>
                {nav === i && <Indicator layoutId="lab-nav-active" dependency={nav} style={{ background: 'var(--lab-surface-3)', zIndex: -1 }} />}
                {t}
              </m.button>
            ))}
          </nav>
        </LayoutGroup>
        <div style={{ ...row, position: 'relative' }}>
          <m.button {...press('button')} style={btn} onClick={() => setOpen((o) => !o)}>
            <RealWidth>{open ? 'Close menu' : 'Menu'}</RealWidth>
          </m.button>
          <button style={btn} onClick={() => setBanner((b) => !b)}>Banner</button>
          <button style={btn} onClick={() => setToastN((n) => (n ?? 0) + 1)}>Toast</button>
          <AnimatePresence>
            {open && (
              <m.div variants={popover('top')} initial="initial" animate="animate" exit="exit" style={menu}>
                {['Copy', 'Undo AI edit', 'Retry', 'Delete'].map((x) => <div key={x} style={{ padding: '6px 10px' }}>{x}</div>)}
              </m.div>
            )}
          </AnimatePresence>
        </div>
        <RealHeight open={banner}>
          <div style={{ ...bannerStyle }}>
            <BlurWords variant="block" text="Quill needs the microphone to hear you." />
          </div>
        </RealHeight>
        <div style={{ height: 8 }} />
        <AnimatePresence mode="popLayout" custom={toastN && toastN > 1 ? 'replace' : undefined}>
          {toastN !== null && (
            <m.div key={toastN} variants={toast} custom={toastN > 1 ? 'replace' : undefined} initial="initial" animate="animate" exit="exit" style={toastStyle}>
              Copied to clipboard · {toastN}
            </m.div>
          )}
        </AnimatePresence>
      </section>

      <p style={{ opacity: 0.5, fontSize: 12 }}>
        Flow Bar window {FLOWBAR.window.width} × {FLOWBAR.window.height} · notice hold {HOLD.notice} ms
      </p>
    </div>
  )
}

function LiveBudget(): React.JSX.Element {
  const [n, setN] = useState(0)
  useEffect(() => {
    let raf = 0
    const loop = (): void => { setN(filterBudget.inUse); raf = requestAnimationFrame(loop) }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])
  return <span data-lab="budget">{n}</span>
}

/* ---- lab-only styles (dark-first) ---- */
const page: React.CSSProperties = {
  ['--fg' as string]: '#f4f2ee', ['--lab-fg' as string]: '#f4f2ee', ['--lab-fg-2' as string]: '#a7a39a',
  ['--lab-surface-3' as string]: '#2a2a2e',
  minHeight: '100vh', boxSizing: 'border-box', padding: 32, background: '#111113', color: 'var(--lab-fg)',
  fontFamily: 'Figtree, system-ui, sans-serif'
}
const card: React.CSSProperties = { background: '#18181b', border: '1px solid #2a2a2e', borderRadius: 16, padding: 20, marginBottom: 16, position: 'relative' }
const eyebrow: React.CSSProperties = { fontSize: 11, letterSpacing: 1, textTransform: 'uppercase', color: '#8a867e', fontFamily: '"Google Sans Code", monospace' }
const row: React.CSSProperties = { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }
const btn: React.CSSProperties = { background: '#2a2a2e', color: 'inherit', border: '1px solid #3a3a40', borderRadius: 10, padding: '6px 12px', font: 'inherit', fontSize: 13, cursor: 'pointer' }
const navBtn: React.CSSProperties = { ...btn, background: 'transparent', border: 'none', position: 'relative', isolation: 'isolate' }
const chip: React.CSSProperties = { fontSize: 12, padding: '3px 10px', borderRadius: 999, background: '#24242a' }
const kbd: React.CSSProperties = { fontFamily: 'inherit', fontSize: '0.7em', padding: '0.05em 0.35em', border: '1px solid #4a4a52', borderRadius: 8, verticalAlign: '0.15em' }
const barCard: React.CSSProperties = { width: 304, boxSizing: 'border-box', padding: '12px 14px', background: '#1d1d21', border: '1px solid #34343a', borderRadius: 16 }
const headLabel: React.CSSProperties = { fontSize: 11, letterSpacing: 1, color: '#8a867e', fontFamily: '"Google Sans Code", monospace' }
const menu: React.CSSProperties = { position: 'absolute', top: 40, left: 0, background: '#222226', border: '1px solid #34343a', borderRadius: 12, padding: 4, transformOrigin: 'top left', zIndex: 100, minWidth: 160 }
const bannerStyle: React.CSSProperties = { marginTop: 12, padding: '10px 14px', borderRadius: 12, background: '#3a2414', border: '1px solid #ff8a3d' }
const toastStyle: React.CSSProperties = { display: 'inline-block', background: '#f4f2ee', color: '#111', borderRadius: 12, padding: '8px 14px', fontSize: 13 }
