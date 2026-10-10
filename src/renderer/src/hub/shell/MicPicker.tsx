import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import { AnimatePresence, LayoutGroup, m, type TargetAndTransition, type Variants } from 'motion/react'
import { Icon, type IconName } from '../../shared/icons'
import { BlurWords, HOLD, Indicator, RealHeight, SPRING, presets, springToLinear, useExitInert, useReduceMotion } from '../../shared/motion'
import { usePlatform, words } from '../../shared/platform'
import { emitPrefs, onPrefs } from './prefsBus'
import './mic-picker.css'

type InputDevice = { id: number; uid: string; name: string; isDefault: boolean }

/** Heights of the seven "Level" bars in the popover head (Ntoc1). */
const BARS = [4, 7, 10, 12, 8, 5, 3]

/** Name-based guess for the row glyph: the helper reports no transport. */
const glyphFor = (name: string): IconName =>
  /airpods|headphone|headset|buds|beats/i.test(name) ? 'headphones' : 'mic-input'

/** After a pick the popover stays this long, so the radio is seen landing (§4.4). */
const PICK_CLOSE_MS = HOLD.coalesce

const POPOVER = presets.popover('top', { blur: true })
/** The notice's text plays `block` on its own; the wrapper only fades on the way out. */
const NOTICE: Variants = { initial: {}, animate: {}, exit: presets.rowInsert.exit }

/** Keeps departed rows in their slot (so they can collapse) and slots new ones in device order. */
function mergeRows(old: InputDevice[], devices: InputDevice[]): InputDevice[] {
  const rows = old.map((o) => devices.find((d) => d.uid === o.uid) ?? o)
  devices.forEach((d, i) => {
    if (rows.some((r) => r.uid === d.uid)) return
    const before = i > 0 ? rows.findIndex((r) => r.uid === devices[i - 1].uid) : -1
    rows.splice(before + 1, 0, d)
  })
  return rows
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))

/** The dictation level, 0..1. It only arrives while dictating; at rest it is null. */
function useLevel(): number | null {
  const [level, setLevel] = useState<number | null>(null)
  useEffect(() => {
    const offLevel = window.flow.dictation.onLevel((v) => setLevel(clamp01(v)))
    const offState = window.flow.dictation.onState((s) => { if (s === 'idle') setLevel(null) })
    return () => { offLevel(); offState() }
  }, [])
  return level
}

/**
 * Title-bar "Mic Picker" (eunDH) and its "Popover / Microphone" (z9wuN7).
 * Same model as Settings › Dictation › Microphone: an empty micUid follows the
 * macOS default; a pinned device that is unplugged stays chosen and shows as
 * not connected while dictation uses the default.
 */
export default function MicPicker({ micMissing, onSettings }: {
  micMissing: boolean; onSettings: () => void
}): React.JSX.Element {
  const reduced = useReduceMotion()
  const w = words(usePlatform().os)
  const [devices, setDevices] = useState<InputDevice[]>([])
  const [rows, setRows] = useState<InputDevice[]>([])
  const [pinned, setPinned] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  // The pinned device went away while the hub was running: the popover says so.
  const [lost, setLost] = useState<{ uid: string; name: string } | null>(null)
  const [ring, setRing] = useState(0)
  const trigger = useRef<HTMLButtonElement>(null)
  const settle = useRef<ReturnType<typeof setTimeout>>(undefined)
  const pickClose = useRef<ReturnType<typeof setTimeout>>(undefined)
  const seenPinned = useRef<string | null>(null)
  const openRef = useRef(open)
  openRef.current = open
  // False on the render that opens the popover, true for everything that joins it later.
  const popLive = useRef(false)
  useEffect(() => { popLive.current = open }, [open])

  useEffect(() => {
    const apply = (list: InputDevice[]): void => { clearTimeout(settle.current); setDevices(list) }
    void window.flow.mic.devices().then(apply)
    void window.flow.settings.get().then((s) => setPinned(s.micUid ?? ''))
    // Plugging a device in fires several list changes: wait for them to settle.
    const offDev = window.flow.mic.onDevices((list) => {
      clearTimeout(settle.current)
      settle.current = setTimeout(() => setDevices(list), HOLD.devicesSettle)
    })
    const offPrefs = onPrefs((p) => { if (p.micUid !== undefined) setPinned(p.micUid) })
    return () => { offDev(); offPrefs(); clearTimeout(settle.current); clearTimeout(pickClose.current) }
  }, [])

  // Rows follow the device list. While the popover is open a departed row stays
  // until it has collapsed; the pinned one stays in place, shown as not connected.
  useEffect(() => {
    setRows((old) => mergeRows(openRef.current ? old : old.filter((o) => o.uid === pinned), devices))
  }, [devices, pinned, open])

  useEffect(() => {
    if (!pinned) { seenPinned.current = null; setLost(null); return }
    if (devices.some((d) => d.uid === pinned)) { seenPinned.current = pinned; setLost(null); return }
    if (seenPinned.current !== pinned) return
    seenPinned.current = null
    setLost({ uid: pinned, name: rows.find((r) => r.uid === pinned)?.name ?? 'Microphone' })
    if (!openRef.current) setRing((n) => n + 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devices, pinned])

  const close = (refocus = true): void => {
    clearTimeout(pickClose.current)
    setOpen(false)
    // Focus goes back to the chip as the exit starts, not after it.
    if (refocus) trigger.current?.focus()
  }

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.stopPropagation(); close() }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open])

  const current = devices.find((d) => d.isDefault)
  const chosen = pinned ? devices.find((d) => d.uid === pinned) : undefined
  const missing = !!pinned && !chosen
  const label = chosen?.name ?? current?.name ?? 'System default'
  const fallback = current?.name ?? 'the system default'

  // The chip's real width follows the device name with spring.ui. Not on the
  // first names to arrive: those are the picker loading, not a change.
  const labelW = useRef<{ w: number; ready: boolean } | null>(null)
  useLayoutEffect(() => {
    const el = trigger.current?.querySelector<HTMLElement>('.mic-trigger__device')
    if (!el) return
    const from = labelW.current
    const to = el.getBoundingClientRect().width
    labelW.current = { w: to, ready: pinned !== null && devices.length > 0 }
    if (!from?.ready || reduced || Math.abs(to - from.w) <= 0.5) return
    const { easing, duration } = springToLinear(SPRING.ui)
    el.animate({ width: [`${from.w}px`, `${to}px`] }, { duration, easing })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label, reduced])

  const choose = async (uid: string): Promise<void> => {
    setPinned(uid)
    clearTimeout(pickClose.current)
    if (reduced) close()
    else pickClose.current = setTimeout(close, PICK_CLOSE_MS)
    const saved = await window.flow.settings.set({ micUid: uid })
    setPinned(saved.micUid)
    emitPrefs({ micUid: saved.micUid })
  }

  const toggle = (): void => {
    if (open) { close(false); return }
    void window.flow.mic.devices().then((list) => { clearTimeout(settle.current); setDevices(list) })
    setOpen(true)
  }

  return (
    <>
      <m.button
        ref={trigger}
        type="button"
        className={`mic-trigger ${open ? 'is-open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Microphone: ${label}`}
        onClick={toggle}
        {...presets.press('button')}
      >
        <LevelDot error={micMissing} ring={ring} />
        <BlurWords variant="label" text={label} className="mic-trigger__device" />
        <Icon name="chevron-down" className="mic-trigger__chev" />
      </m.button>

      {open && <div className="mic-scrim" onClick={() => close()} />}
      <AnimatePresence>
        {open && (
          <Popover key="pop">
            <div className="mic-pop__head">
              <span className="mic-pop__label">MICROPHONE</span>
              <LevelBars />
            </div>

            <LayoutGroup id="mic">
              <div className="mic-pop__rows">
                <Slot live={popLive.current} open={lost?.uid === pinned && missing} content={NOTICE}>
                  {(live) => (
                    <p className="mic-pop__notice">
                      <BlurWords variant="block" initial={live} text={`${lost?.name ?? 'Microphone'} disconnected, using ${fallback}`} />
                    </p>
                  )}
                </Slot>

                <div className="mic-slot">
                  <DeviceRow
                    name="System default"
                    detail={`${w.follows}${current ? ` · now ${current.name}` : ''}`}
                    selected={pinned === ''}
                    pinned={pinned}
                    onPick={() => void choose('')}
                  />
                </div>
                {rows.map((r) => {
                  const here = devices.some((d) => d.uid === r.uid)
                  const ghost = !here && r.uid === pinned
                  return (
                    <Slot
                      key={r.uid}
                      live={popLive.current}
                      open={here || ghost}
                      onExited={() => setRows((cur) => cur.filter((c) => c.uid !== r.uid || devices.some((d) => d.uid === c.uid) || c.uid === pinned))}
                    >
                      {() => (
                        <DeviceRow
                          name={r.name}
                          detail={ghost ? `Not connected · using ${fallback}` : r.isDefault ? `${w.systemDefault} input` : 'Connected'}
                          icon={glyphFor(r.name)}
                          selected={pinned === r.uid}
                          disconnected={ghost}
                          pinned={pinned}
                          onPick={() => void choose(r.uid)}
                        />
                      )}
                    </Slot>
                  )
                })}
                {/* Pinned, but never seen connected in this session: its name is unknown. */}
                <Slot live={popLive.current} open={missing && !rows.some((r) => r.uid === pinned)}>
                  {() => (
                    <DeviceRow
                      name="Chosen microphone"
                      detail={`Not connected · using ${fallback}`}
                      selected
                      disconnected
                      pinned={pinned}
                      onPick={() => void choose(pinned ?? '')}
                    />
                  )}
                </Slot>
              </div>
            </LayoutGroup>

            <div className="mic-pop__divider" aria-hidden />
            <button type="button" role="menuitem" className="mic-pop__footer" onClick={() => { close(false); onSettings() }}>
              <Icon name="sliders" className="mic-pop__footIcon" />
              <span className="mic-pop__footLabel">Dictation settings</span>
              <Icon name="chevron-right" className="mic-pop__footChev" />
            </button>
          </Popover>
        )}
      </AnimatePresence>
    </>
  )
}

/** "Popover / Microphone" (z9wuN7): opens from under the chip, top right (§4.4). */
function Popover({ children, ref }: { children: ReactNode; ref?: Ref<HTMLDivElement> }): React.JSX.Element {
  const inert = useExitInert()
  return (
    <m.div
      ref={ref}
      className="mic-pop"
      role="menu"
      aria-label="Microphone"
      inert={inert.inert}
      style={{ originX: 1, originY: 0, ...inert.style }}
      variants={POPOVER}
      initial="initial"
      animate="animate"
      exit="exit"
    >
      {children}
    </m.div>
  )
}

/**
 * One row slot with a real height, so hot-plugged rows grow in and collapse
 * out while their neighbours reflow. Rows already there when the popover opens
 * come in with it; `children` is told whether it arrived later (`live`).
 */
function Slot({ live, open, content, onExited, children }: {
  live: boolean; open: boolean; content?: Variants; onExited?: () => void; children: (live: boolean) => ReactNode
}): React.JSX.Element {
  // A slot that mounts into an open popover (a new device) animates its first row.
  const [initial] = useState(live)
  return (
    <RealHeight open={open} initial={initial} content={content} onExited={onExited}>
      <div className="mic-slot">{children(live)}</div>
    </RealHeight>
  )
}

/** Chip "Level" dot: follows the level while dictating, static otherwise (and under Reduce Motion). */
function LevelDot({ error, ring }: { error: boolean; ring: number }): React.JSX.Element {
  const reduced = useReduceMotion()
  const [rung, setRung] = useState(0)
  const level = useLevel()
  const moving = level !== null && !reduced
  const pulse = presets.ring('dot')
  return (
    <m.span
      className={`mic-trigger__level ${error ? 'is-error' : ''}`}
      aria-hidden
      initial={false}
      animate={moving ? { scale: 1 + 0.6 * (level ?? 0), opacity: 0.6 + 0.4 * (level ?? 0) } : { scale: 1, opacity: 1 }}
      transition={SPRING.meter}
    >
      {/* One ring when the chosen device drops out while the popover is closed. */}
      {ring > rung && !reduced && (
        <m.span
          key={ring}
          className="mic-trigger__ring"
          initial={pulse.initial as TargetAndTransition}
          animate={pulse.animate as TargetAndTransition}
          transition={pulse.transition}
          onAnimationComplete={() => setRung(ring)}
        />
      )}
    </m.span>
  )
}

/** Popover head "Level" bars (Ntoc1). A leaf, so the level never re-renders the rows. */
function LevelBars(): React.JSX.Element {
  const lit = Math.round((useLevel() ?? 0) * BARS.length)
  return (
    <span className="mic-pop__meter" aria-hidden>
      {BARS.map((h, i) => (
        <span key={i} className={`mic-pop__bar ${i < lit ? 'is-lit' : ''}`} style={{ height: h }} />
      ))}
    </span>
  )
}

/** "Device Row" (Pt9OA) / "Device Row / Selected" (f4b9z); disconnected per the AirPods instance. */
function DeviceRow({ name, detail, icon = 'mic-input', selected, disconnected, pinned, onPick }: {
  name: string; detail: string; icon?: IconName; selected: boolean; disconnected?: boolean
  /** The chosen uid: what the shared radio dot follows. */
  pinned: string | null
  onPick: () => void
}): React.JSX.Element {
  const cls = ['mic-row', selected && !disconnected && 'is-selected', disconnected && 'is-disconnected', selected && 'is-checked']
    .filter(Boolean).join(' ')
  return (
    <button type="button" role="menuitemradio" aria-checked={selected} className={cls} onClick={onPick}>
      <span className="mic-row__chip">
        <Icon name={disconnected ? 'mic-input' : icon} active={selected && !disconnected} />
      </span>
      <span className="mic-row__text">
        <span className="mic-row__name">{name}</span>
        <span className="mic-row__detail">{detail}</span>
      </span>
      <span className="mic-row__radio" aria-hidden>
        <span className="mic-row__dot">
          {selected && <Indicator layoutId="mic-radio" dependency={pinned} transition={SPRING.snappy} className="mic-row__dotFill" />}
        </span>
      </span>
    </button>
  )
}
