import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { AnimatePresence, m, type TargetAndTransition, type Variants } from 'motion/react'
import { Icon } from '../shared/icons'
import { Badge, Bento, IconButton, Keycap } from '../shared/ui'
import {
  BlurWords, HOLD, LEVEL, SPRING, WORD_VARIANTS, animateWord, isReducedMotion, presets, springToLinear,
  staggerDelay, tween, useExitInert, useReduceMotion, type BlurPart
} from '../shared/motion'
import { MostUsedTile, StreakTile, WordsTodayTile, WpmTile, isoDay, type Insights } from './Insights'
import {
  AFTER_ROW_MS, AT, Count, EntranceProvider, EntranceTile, MTileTop, fadeAt, heroBlur, useEntrance,
  useEntranceStep, useFirstEntrance, useLagged, usePhase
} from './dictationMotion'
import { accelKeys, chord, has, holdKeyFor, usePlatform } from '../shared/platform'
import { useBanner } from './PermissionBanner'
import { showToast } from './shell/toastBus'
import { useSpeechModel } from './onboarding/speechModel'
import './dictation.css'

/* Hub, Dictation (vBtIm; light pJRmT; banner variants f9cd0 / iUNKf).
   DOM follows the node tree: Bento > Row 1 | Row 2 | Row 3 > tiles.
   Motion: docs/MOTION.md §4.3 (wired in dictationMotion.tsx). */

type Row = {
  id: string; text: string; at: number; words: number; durationMs: number
  app?: string; flagged?: boolean; failed?: string
}
type Live = 'idle' | 'recording' | 'transcribing' | 'polishing'

/* The rows are shorter under a banner (dictation.css). They change height on
   the banner's own spring, so the bento moves as one with it: spring.ui while
   it comes in, spring.exit while it leaves. */
const reflow = (spring: typeof SPRING.ui | typeof SPRING.exit): CSSProperties => {
  const { duration, easing } = springToLinear(spring)
  return { '--dict-reflow-dur': `${duration}ms`, '--dict-reflow-ease': easing } as CSSProperties
}
const REFLOW_IN = reflow(presets.HEIGHT.open)
const REFLOW_OUT = reflow(presets.HEIGHT.close)

/** Recent shows four rows; under a Banner Slot (f9cd0 / iUNKf) the tile fits three. */
const VISIBLE = 4
const VISIBLE_WITH_BANNER = 3

export default function DictationScreen({ holdEntrance = false, onOpenSettings }: {
  /** The setup screen covers the hub: the first entrance waits for it to close. */
  holdEntrance?: boolean
  onOpenSettings?: (pane: FlowSettingsPane) => void
}): React.JSX.Element {
  // null until the first list arrives: rows that come later are live inserts.
  const [rows, setRows] = useState<Row[] | null>(null)
  const [ins, setIns] = useState<Insights | null>(null)
  const [perms, setPerms] = useState<FlowPerms | null>(null)
  const [prefs, setPrefs] = useState<{ holdKey: number; toggleShortcut: string; padShortcut: string; aiEnabled: boolean } | null>(null)
  const [cleanupKey, setCleanupKey] = useState(false)
  const [live, setLive] = useState<Live>('idle')
  const [history, setHistory] = useState(false)
  const phase = useFirstEntrance(holdEntrance)
  const banner = useBanner()

  const loadInsights = (): void => { void window.flow.dictations.insights().then((i) => setIns(i as Insights)) }
  const loadPrefs = (): void => {
    void window.flow.settings.get().then((s) => setPrefs(s))
    void window.flow.cleanup.status().then((c) => setCleanupKey(c.hasKey))
  }

  // History is persisted, so it survives a restart; new dictations push in live.
  useEffect(() => {
    void window.flow.dictations.list().then((r) => setRows(r as Row[]))
    loadInsights()
    loadPrefs()
    void window.flow.perms.status().then(setPerms)
    const onFocus = (): void => { loadPrefs(); void window.flow.perms.status().then(setPerms) }
    window.addEventListener('focus', onFocus)
    let timer: ReturnType<typeof setTimeout> | undefined
    // Cause, then effect: the new row lands first, the counters it changed follow.
    const onAdded = (): void => {
      const next = window.flow.dictations.insights()
      void window.flow.dictations.list().then((r) => {
        setRows(r as Row[])
        const apply = (): void => { void next.then((i) => setIns(i as Insights)) }
        clearTimeout(timer)
        if (isReducedMotion() || document.visibilityState !== 'visible') apply()
        else timer = setTimeout(apply, AFTER_ROW_MS.counters)
      })
    }
    const offs = [
      window.flow.dictations.onAdded(onAdded),
      window.flow.perms.onChanged(setPerms),
      window.flow.dictation.onState((s) => setLive(s === 'recording' ? 'recording' : 'idle')),
      window.flow.dictation.onStage((s) => setLive((cur) => (s === 'idle' ? (cur === 'recording' ? cur : 'idle') : s)))
    ]
    return () => { window.removeEventListener('focus', onFocus); clearTimeout(timer); offs.forEach((off) => off()) }
  }, [])

  const update = (next: unknown): void => {
    setRows(next as Row[])
    loadInsights()
  }

  const cls = `dict${history ? ' is-history' : ''}${banner.open ? ' has-banner' : ''}${banner.live ? ' is-live' : ''}`
  // The entrance is still to come and the setup screen covers the bento: the
  // tiles are not there yet. Held initial frames would sit blurred under it,
  // spending filter slots the setup screen needs (§3.5), for nobody to see.
  if (holdEntrance && phase === 'hold') return <Bento className={cls} />
  return (
    <EntranceProvider value={phase}>
      <Bento className={cls} style={banner.open ? REFLOW_IN : REFLOW_OUT}>
        <div className="dict__row dict__row--1">
          <HeroTile perms={perms} prefs={prefs} live={live} onOpenSettings={onOpenSettings} />
          <WordsTodayTile d={ins} />
          <WpmTile d={ins} />
        </div>

        <div className="dict__row dict__row--2">
          <StreakTile d={ins} />
          <MostUsedTile d={ins} />
        </div>

        <div className="dict__row dict__row--3">
          <RecentTile
            rows={rows}
            visible={banner.open ? VISIBLE_WITH_BANNER : VISIBLE}
            calm={!banner.live}
            canRetry={!!prefs?.aiEnabled && cleanupKey}
            history={history}
            onHistory={() => setHistory((h) => !h)}
            onChange={update}
          />
          <ScratchpadTile shortcut={prefs?.padShortcut ?? ''} />
        </div>
      </Bento>
    </EntranceProvider>
  )
}

/* ---- Hero / Hold fn (MxUUF → Tile / Hero Dlemh, padding 20) ---- */
const CHIP_IN = fadeAt(AT.chip)
const WAVE_IN = fadeAt(AT.wave)

function HeroTile({ perms, prefs, live, onOpenSettings }: {
  perms: FlowPerms | null
  prefs: { holdKey: number; toggleShortcut: string } | null
  live: Live
  onOpenSettings?: (pane: FlowSettingsPane) => void
}): React.JSX.Element {
  const reduced = useReduceMotion()
  // Local transcription without its model on disk: the chip says so, live.
  const model = useSpeechModel(false)
  const phase = usePhase()
  const blurTop = useEntrance(heroBlur)
  const blurBottom = useEntrance(heroBlur)
  const chipIn = useEntrance(CHIP_IN)
  const waveIn = useEntrance(WAVE_IN)
  const platform = usePlatform()
  // Shortcut names in this OS's words; the stored default covers the moment before settings arrive.
  const toggle = accelKeys(prefs?.toggleShortcut ?? (platform.os === 'macos' ? 'Control+Alt+D' : 'Alt+Shift+D'), platform.os)
    .join(platform.os === 'macos' ? ' ' : '+')
  // undefined when the hold key is Off, or when this system has none (Wayland)
  const hold = holdKeyFor(prefs?.holdKey, platform)?.name
  // Without `insert` a dictation is copied to the clipboard, never typed.
  const typed = has(platform, 'insert')
  const paste = chord('V', platform.os).cap
  const micOff = !!perms && perms.mic !== 'granted' && perms.mic !== 'unknown'
  const axOff = !!perms && !perms.ax

  // Mic missing (f9cd0) and Accessibility off (iUNKf) are their own hero states.
  type Hero = { tone: 'ready' | 'mic' | 'ax' | 'busy'; chip: string; lead: string; key?: string; tail?: string; hint: string; wave: boolean }
  let h: Hero
  if (micOff) {
    h = { tone: 'mic', chip: 'Mic access off', lead: 'Allow the mic.', hint: 'Dictation can’t record until the microphone is allowed', wave: false }
  } else if (axOff || !hold) {
    h = {
      tone: 'ax',
      chip: axOff ? `Hold key off · ${toggle} works` : `Ready · ${toggle} to start`,
      lead: 'Use', key: toggle, tail: 'to talk.',
      hint: axOff || !typed ? `Text is copied: paste it with ${paste}` : 'Press it again to stop and paste where your cursor is',
      wave: true
    }
  } else {
    h = {
      tone: 'ready', chip: `Ready · listening for ${hold}`, lead: 'Hold', key: hold, tail: 'to talk.',
      hint: typed ? `Release to paste where your cursor is · ${toggle} for hands-free` : `Release to copy the text · ${toggle} for hands-free`, wave: true
    }
  }
  // No speech model yet (setup was left while it downloads, or it was removed):
  // the chip reports that in place of "Ready". The mic states come first.
  const fetching = !micOff && model.state === 'downloading'
  const noModel = !micOff && (model.state === 'failed' || model.state === 'idle')
  if (fetching) h = { ...h, chip: 'Getting the speech model ·' }
  if (noModel) h = { ...h, chip: 'Speech model missing' }
  // While a dictation runs, the chip reports it whatever the resting state.
  if (live !== 'idle' && !micOff) {
    h = { ...h, tone: 'busy', chip: live === 'recording' ? 'Listening…' : live === 'transcribing' ? 'Transcribing…' : 'Polishing…' }
  }
  const recording = live === 'recording'
  const pulsing = recording && !reduced

  // Until the permissions and the keys are known the copy may still change, so
  // it is held unseen; the settled copy then mounts once and never replays.
  const ready = !!perms && !!prefs && model.state !== 'checking'
  const idle = live === 'idle' || micOff
  const percent = fetching && idle ? model.percent : undefined
  // Missing: the chip is the way to the pane where a model is picked.
  const fix = noModel && idle && onOpenSettings ? () => onOpenSettings('models') : undefined
  const state = `${fetching && idle ? ' is-fetching' : ''}${noModel && idle ? ' is-nomodel' : ''}`
  const copy = ready ? 'ready' : 'pending'
  const headline = `${copy} ${h.lead} ${h.key ?? ''} ${h.tail ?? ''}`
  const bottomRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const tile = bottomRef.current?.parentElement
    if (!tile) return
    const fit = (): void => fitHeadline(tile)
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(tile)
    ro.observe(bottomRef.current!)          // the hint may wrap onto a second line
    let live = true
    void document.fonts?.ready.then(() => { if (live) fit() })
    return () => { live = false; ro.disconnect() }
  }, [headline, reduced])

  const parts: BlurPart[] = [h.lead]
  if (h.key) parts.push({ node: <span className="dict-hero__key"><span className="dict-hero__keylabel">{h.key}</span></span>, text: h.key })
  if (h.tail) parts.push(h.tail)

  return (
    <EntranceTile name="hero" blur={false} accent="violet" hero className={`dict-hero dict-hero--${h.tone}${recording ? ' is-recording' : ''}${state}`}>
      <MTileTop
        {...blurTop}
        label="DICTATION"
        right={
          <Chip {...chipIn} onClick={fix}>
            <m.span
              className="dict-hero__dot"
              aria-hidden
              initial={false}
              animate={pulsing ? presets.pulse.animate : { opacity: 1 }}
              transition={pulsing ? presets.pulse.transition : tween('fast', 'standard')}
            />
            <ChipLabel key={copy} text={h.chip} />
            {percent !== undefined && (
              <span className="dict-hero__chiptext dict-hero__chipnum"><Count value={percent} />%</span>
            )}
            {fix && <Icon name="chevron-right" className="dict-hero__chipgo" />}
          </Chip>
        }
      />
      <BlurWords
        key={copy}
        as="h1"
        className="dict-hero__headline"
        variant="headline"
        parts={parts}
        initial={!ready || phase !== 'rest'}
        hold={!ready || phase === 'hold'}
        delay={phase === 'rest' ? 0 : AT.headline}
      />
      <m.div ref={bottomRef} className="dict-hero__bottom" {...blurBottom}>
        <span className="dict-hero__hint">{h.hint}</span>
        {h.wave && (
          <m.span className="dict-hero__wave" aria-hidden {...waveIn}>
            <MiniWave live={recording} />
          </m.span>
        )}
      </m.div>
    </EntranceTile>
  )
}

/* The headline is drawn for "Hold fn to talk." at 56. A longer key ("Caps
   Lock", a toggle shortcut) or a narrower tile may not hold that on one line:
   it then wraps between its parts (the Key never splits, "to talk." stays
   together) and, when two lines are taller than the tile allows, steps down a
   size until it fits. A headline that fits as drawn is never touched. */
const HEADLINE_STEPS = [1, 0.875, 0.75, 0.625, 0.5]
/** Least air kept above and below the headline, in px. */
const HEADLINE_AIR = 10

function fitHeadline(tile: HTMLElement): void {
  const h1 = tile.querySelector<HTMLElement>('.dict-hero__headline')
  const top = tile.querySelector<HTMLElement>('.q-tile__top')
  const bottom = tile.querySelector<HTMLElement>('.dict-hero__bottom')
  if (!h1 || !top || !bottom) return
  h1.style.removeProperty('--hl-k')
  delete h1.dataset.fit
  const cs = getComputedStyle(tile)
  const width = tile.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
  if (width <= 0 || h1.offsetWidth <= width) return
  const height = tile.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)
    - top.offsetHeight - bottom.offsetHeight - 2 * HEADLINE_AIR
  const toks = Array.from(h1.querySelectorAll<HTMLElement>('.bw-layer:not([data-exiting]) > .bw-tok'))
  const isKey = (el: HTMLElement): boolean => !!el.querySelector('.dict-hero__key')
  // A word that follows another word of the same text must not start a line.
  const split = (): boolean => toks.some((t, i) =>
    i > 0 && !isKey(t) && !isKey(toks[i - 1]) && Math.abs(t.offsetTop - toks[i - 1].offsetTop) > 1)
  const fits = (): boolean => h1.scrollWidth <= width && h1.offsetHeight <= height && !split()
  for (const k of HEADLINE_STEPS) {
    h1.style.setProperty('--hl-k', String(k))
    // Free wrapping first; if that strands "talk." on its own, break after the Key instead.
    h1.dataset.fit = 'wrap'
    if (fits()) return
    h1.dataset.fit = 'break'
    if (fits()) return
  }
}

/* "Ready" (JWa16). A status at rest; with `onClick` (the speech model is
   missing) the same pill is a button to where that is fixed. */
function Chip({ onClick, children, ...motion }: {
  onClick?: () => void; children: React.ReactNode
} & ReturnType<typeof useEntrance>): React.JSX.Element {
  return onClick ? (
    <m.button type="button" className="dict-hero__chip dict-hero__chip--go m-hover" onClick={onClick} {...motion}>
      {children}
    </m.button>
  ) : (
    <m.span className="dict-hero__chip" role="status" {...motion}>{children}</m.span>
  )
}

/* "Text" (UlMkq) of the Ready chip. The label swaps as one unit (`label`) and
   the chip's real width follows with spring.ui (BlurWords `animateWidth`). The
   box clips the outgoing label while the width moves. */
function ChipLabel({ text }: { text: string }): React.JSX.Element {
  return (
    <span className="dict-hero__chipbox">
      <BlurWords variant="label" animateWidth className="dict-hero__chiptext" text={text} />
    </span>
  )
}

/* "Wave" (Boi0p) bars at rest, as drawn. While recording they follow the mic
   level; the level never becomes React state (it is written to the bars here). */
const WAVE = [6, 12, 20, 14, 24, 10, 16, 8, 18, 6]
const WAVE_MIN = 3
/** Quiet speech keeps a quarter of each bar; a level of 0.5 fills it. */
const gainFor = (level: number): number => Math.min(1, 0.25 + level * 1.5)
/** Closer to rest than this, the bars snap to it and the loop stops. */
const WAVE_SETTLED = 0.01

function MiniWave({ live }: { live: boolean }): React.JSX.Element {
  const reduced = useReduceMotion()
  const bars = useRef<(HTMLSpanElement | null)[]>([])
  const s = useRef({ level: 0, target: 0, gain: 1 })

  useEffect(() => {
    const st = s.current
    const paint = (gain: number): void => bars.current.forEach((el, i) => {
      if (el) el.style.height = `${Math.max(WAVE_MIN, Math.round(WAVE[i] * gain))}px`
    })
    // Reduce Motion: the bars stay as drawn (the Flow Bar carries the meter).
    if (reduced) { st.level = 0; st.gain = 1; paint(1); return }
    if (!live && st.gain === 1) return
    st.target = 0
    const off = live ? window.flow.dictation.onLevel((v) => { st.target = v }) : undefined
    let raf = 0
    let last = 0
    const tick = (now: number): void => {
      const k = Math.pow(LEVEL.decay, (last ? now - last : LEVEL.frameMs) / LEVEL.frameMs)
      last = now
      // Attack in one frame, release with LEVEL.decay.
      st.level = st.target > st.level ? st.target : st.target + (st.level - st.target) * k
      const want = live ? gainFor(st.level) : 1
      st.gain = want + (st.gain - want) * k
      if (!live && 1 - st.gain < WAVE_SETTLED) { st.gain = 1; paint(1); return }
      paint(st.gain)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(raf); off?.() }
  }, [live, reduced])

  return (
    <>
      {WAVE.map((b, i) => (
        <span key={i} ref={(el) => { bars.current[i] = el }} className="dict-hero__bar" style={{ height: b }} />
      ))}
    </>
  )
}

/* ---- Tile / Recent dictations (l15GP) ---- */
function RecentTile({ rows, visible, calm, canRetry, history, onHistory, onChange }: {
  rows: Row[] | null; visible: number; calm: boolean; canRetry: boolean; history: boolean
  onHistory: () => void; onChange: (rows: unknown) => void
}): React.JSX.Element {
  const all = rows ?? []
  const today = isoDay(Date.now())
  const todayCount = all.filter((r) => !r.failed && isoDay(r.at) === today).length
  const shown = history ? all : all.slice(0, visible)

  return (
    <EntranceTile name="recent" className="dict-recent">
      <div className="dict-recent__top">
        <span className="dict-label">{history ? 'ALL DICTATIONS' : 'RECENT DICTATIONS'}</span>
        {all.length > visible || history ? (
          <button type="button" className="dict-recent__link m-hover" onClick={onHistory}>
            <span>{history ? 'Show less' : <>All <LaggedCount value={todayCount || all.length} />{todayCount ? ' today' : ''}</>}</span>
            <Icon name={history ? 'chevron-up' : 'chevron-right'} />
          </button>
        ) : null}
      </div>
      {/* Keyed: switching between the four rows and the full history is not a list change. */}
      <RecentList key={history ? 'all' : 'recent'} rows={shown} loaded={rows !== null} calm={calm} canRetry={canRetry} onChange={onChange} />
    </EntranceTile>
  )
}

/** "All 38 today": the count moves after the row that changed it. */
function LaggedCount({ value }: { value: number }): React.JSX.Element {
  return <Count value={useLagged(value, AFTER_ROW_MS.counters)} />
}

/** Why a row is leaving: deleted by the user, pushed out by a newer one, or dropped with no motion. */
type RowExit = { deleted: string | null; instant: boolean }

/* The item's real height opens with spring.ui and closes with spring.exit; the
   rows beside it reflow natively. */
const ITEM: Variants = {
  closed: { height: 0 },
  open: { height: 'auto', transition: presets.HEIGHT.open },
  exit: (why?: RowExit) => ({ height: 0, transition: why?.instant ? tween('instant') : presets.HEIGHT.close })
}
/** First entrance: rows fade up from t = 240, `stagger.list`. */
const ROW_ENTRANCE = presets.fadeUpStagger({ start: AT.viz })

function RecentList({ rows, loaded, calm, canRetry, onChange }: {
  rows: Row[]; loaded: boolean; calm: boolean; canRetry: boolean; onChange: (rows: unknown) => void
}): React.JSX.Element {
  // Rows present when the list first has data are not inserts; later ones are.
  const [live, setLive] = useState(false)
  useEffect(() => { if (loaded) setLive(true) }, [loaded])
  const [deleted, setDeleted] = useState<string | null>(null)
  const reduced = useReduceMotion()
  const why = useMemo<RowExit>(() => ({ deleted, instant: calm || reduced }), [deleted, calm, reduced])

  return (
    <div className="dict-recent__list">
      <AnimatePresence initial={false} custom={why}>
        {rows.map((row, i) => (
          <RecentRow key={row.id} row={row} index={i} fresh={live} canRetry={canRetry} onDelete={setDeleted} onChange={onChange} />
        ))}
      </AnimatePresence>
      {loaded && !rows.length && (
        <BlurWords
          as="p"
          className="dict-empty dict-recent__empty"
          variant="title"
          initial={live}
          text="Nothing dictated yet. Hold the key and speak."
        />
      )}
    </div>
  )
}

/* A new row's text plays body.compact: the first eight words blur in one by
   one, and whatever follows fades in as one piece with the eighth (most of it
   is past the ellipsis anyway). */
const COMPACT = WORD_VARIANTS.bodyCompact

function RowText({ text }: { text: string }): React.JSX.Element {
  const words = text.trim().split(/\s+/)
  const rest = words.length > COMPACT.cap ? ' ' + words.slice(COMPACT.cap).join(' ') : ''
  const restRef = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    if (!restRef.current) return
    const h = animateWord(restRef.current, {
      delay: staggerDelay(COMPACT.cap - 1, COMPACT.stagger),
      opacity: { from: 0, to: 1, duration: COMPACT.opacity, ease: COMPACT.ease }
    })
    return () => h.cancel()
  }, [text])
  return (
    <>
      <BlurWords variant="bodyCompact" userContent text={words.slice(0, COMPACT.cap).join(' ')} />
      {rest && <span ref={restRef}>{rest}</span>}
    </>
  )
}

function RecentRow({ row, index, fresh, canRetry, onDelete, onChange }: {
  row: Row; index: number; fresh: boolean; canRetry: boolean
  onDelete: (id: string) => void; onChange: (rows: unknown) => void
}): React.JSX.Element {
  const { step, entering } = useEntranceStep()
  const inert = useExitInert()
  // How this row arrived: a live insert, part of the first entrance, or at rest.
  // A row that arrives while the hub is hidden is simply there.
  const [mode] = useState<'insert' | 'entrance' | 'rest'>(() =>
    fresh && document.visibilityState === 'visible' ? 'insert' : entering ? 'entrance' : 'rest')
  // The text reveals word by word only for a row the user watched arrive, or after a re-run.
  const [reveal, setReveal] = useState(() => mode === 'insert' && document.hasFocus())
  const [open, setOpen] = useState(mode !== 'insert')
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])

  const variants = useMemo<Variants>(() => ({
    initial: mode === 'entrance' ? ROW_ENTRANCE.initial : presets.recentRowInsert.initial,
    animate: mode === 'entrance' ? ROW_ENTRANCE.animate : presets.recentRowInsert.animate,
    exit: (why?: RowExit): TargetAndTransition => (
      why?.instant ? { opacity: 0, transition: tween('instant') }
        : why?.deleted === row.id ? presets.rowDelete.exit
          : presets.recentRowInsert.exit
    ) as TargetAndTransition
  }), [mode, row.id])

  const time = new Date(row.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })

  const copy = (): void => {
    if (row.failed) return
    void navigator.clipboard.writeText(row.text)
    showToast('Copied to clipboard')
    setCopied(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), HOLD.copied)
  }
  const retry = async (): Promise<void> => {
    setBusy(true)
    try {
      const next = await window.flow.dictations.retry(row.id)
      setReveal(true)
      onChange(next)
    } finally { setBusy(false) }
  }
  // A failed recording has nothing to re-run: retrying starts a hands-free
  // dictation instead (stop it with the toggle shortcut) and drops the miss.
  const dictateAgain = async (): Promise<void> => {
    onDelete(row.id)
    onChange(await window.flow.dictations.remove(row.id))
    void window.flow.dictation.start()
  }
  const flag = async (): Promise<void> => onChange(await window.flow.dictations.flag(row.id, !row.flagged))
  const remove = async (): Promise<void> => {
    onDelete(row.id)
    onChange(await window.flow.dictations.remove(row.id))
  }

  return (
    <m.div
      className="dict-recent__item"
      inert={inert.inert}
      style={{ overflow: open && !inert.inert ? undefined : 'hidden', ...inert.style }}
      variants={ITEM}
      initial={mode === 'insert' ? 'closed' : false}
      animate="open"
      exit="exit"
      onAnimationComplete={() => setOpen(true)}
    >
      <m.div
        className={`dict-row m-hover${row.failed ? ' dict-row--failed' : ''}${row.flagged ? ' is-flagged' : ''}${busy ? ' is-busy' : ''}`}
        tabIndex={0}
        title={row.failed ? undefined : 'Click to copy · Delete to remove'}
        variants={variants}
        custom={index}
        initial={mode === 'rest' ? false : 'initial'}
        animate={mode === 'entrance' ? step : 'animate'}
        exit="exit"
        onClick={(e) => { if (!(e.target as HTMLElement).closest('.dict-row__actions')) copy() }}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return
          if (e.key === 'Enter') copy()
          if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); void remove() }
        }}
      >
        <span className="dict-row__time">{time}</span>
        <span className="dict-row__text">{row.failed ? row.failed : reveal ? <RowText text={row.text} /> : row.text}</span>
        {row.app && !row.failed && <Badge className="dict-row__app">{row.app}</Badge>}
        <div className="dict-row__actions">
          {row.failed ? (
            <IconButton icon="retry" label="Dictate again (hands-free)" className="dict-row__btn dict-row__btn--error" onClick={() => void dictateAgain()} />
          ) : (
            <>
              <IconButton icon={copied ? 'check' : 'copy'} label={copied ? 'Copied' : 'Copy'} className="dict-row__btn dict-row__btn--hover" onClick={copy} />
              {canRetry && (
                <IconButton icon="retry" label="Run AI cleanup again" disabled={busy} className="dict-row__btn dict-row__btn--hover" onClick={() => void retry()} />
              )}
              <IconButton
                icon="flag"
                active={!!row.flagged}
                label={row.flagged ? 'Unflag' : 'Flag'}
                className={`dict-row__btn ${row.flagged ? 'dict-row__btn--flagged' : 'dict-row__btn--hover'}`}
                onClick={() => void flag()}
              />
            </>
          )}
        </div>
      </m.div>
    </m.div>
  )
}

/* ---- Tile / Scratchpad (tCsVi → cXqXD) ---- */
function ScratchpadTile({ shortcut }: { shortcut: string }): React.JSX.Element {
  const { os } = usePlatform()
  const open = (): void => window.flow.pad.open()
  return (
    <EntranceTile
      name="scratchpad"
      className="dict-pad m-hover"
      role="button"
      tabIndex={0}
      aria-label="Open Scratchpad"
      onClick={open}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() } }}
      {...presets.press('card')}
    >
      <div className="dict-pad__top">
        <span className="dict-pad__chip"><Icon name="notepad" size={20} /></span>
        <Icon name="external" size={20} className="dict-pad__ext" />
      </div>
      <div className="dict-pad__bottom">
        <span className="dict-pad__title">Open Scratchpad</span>
        {shortcut && (
          <span className="dict-pad__shortcut">
            {accelKeys(shortcut, os).map((k, i) => <Keycap key={i}>{k}</Keycap>)}
          </span>
        )}
      </div>
    </EntranceTile>
  )
}
