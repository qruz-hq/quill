import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { LayoutGroup, m, type TargetAndTransition, type Variants } from 'motion/react'
import { Icon } from '../shared/icons'
import { BlurWords, DIST, HOLD, PresenceSwap, SCALE, SPRING, presets, useExitInert } from '../shared/motion'
import { INSTANT, tw } from './motion'

export const toKey = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const fromKey = (k: string): Date => {
  const [y, m, d] = k.split('-').map(Number)
  return new Date(y, m - 1, d)
}

const addDays = (d: Date, n: number): Date => {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}

/** Date Picker QjrFy: width 320. Its height is measured after render. */
const PICKER_W = 320
const QUICK_TIMES = ['9:00', '12:00', '14:00', '17:00']
/** main's TODOS_PICKER_HEIGHT: the window is this tall while a picker is open. */
const PICKER_WINDOW_H = 640

/**
 * The window grows to fit the picker (todos:picker) and goes back once the
 * last one has finished leaving.
 */
let openPickers = 0
let grown = false
const syncWindow = (): void => {
  if (grown === openPickers > 0) return
  grown = openPickers > 0
  window.flow.todos.setPickerOpen(grown)
}
/** Keeps the window grown until the returned release runs. */
function holdWindow(): () => void {
  openPickers++
  syncWindow()
  // Deferred a tick: closing one picker by opening another must not shrink in between.
  return () => { openPickers--; setTimeout(syncWindow, 0) }
}

type Place = { top: number; left: number; flipped: boolean; origin: string }

/** Popover rules (§4.11) with the origin at the chip: y comes from the chip's side, known once measured. */
const PICKER: Variants = {
  initial: { opacity: 0, scale: SCALE.enter },
  animate: (flipped: boolean) => ({
    opacity: 1, scale: 1, y: [flipped ? DIST.sm : -DIST.sm, 0],
    transition: { default: SPRING.ui, opacity: tw('fast') }
  }),
  exit: { opacity: 0, scale: SCALE.exit, transition: tw('micro', 'exit') }
}

type MonthCustom = { dir: number; instant: boolean }
const call = (v: unknown, arg: unknown): TargetAndTransition =>
  (typeof v === 'function' ? (v as (a: unknown) => TargetAndTransition)(arg) : v) as TargetAndTransition
/** Month swap on a shared X axis; instant while the arrows are being spammed. */
const MONTH: Variants = {
  initial: (c: MonthCustom) => (c.instant ? { opacity: 1, x: 0 } : call(presets.monthSwap.initial, c.dir)),
  animate: (c: MonthCustom) => (c.instant ? { opacity: 1, x: 0, transition: INSTANT } : call(presets.monthSwap.animate, c.dir)),
  exit: (c: MonthCustom) => (c.instant ? { opacity: 0, transition: INSTANT } : call(presets.monthSwap.exit, c.dir))
}

/** Accepts 9, 9:5, 09:05, 9.30 -> "09:05"; anything else -> null. */
export function parseTime(raw: string): string | null {
  const m = /^\s*(\d{1,2})(?:[:.h](\d{1,2}))?\s*$/.exec(raw)
  if (!m) return null
  const h = Number(m[1]), mi = Number(m[2] ?? 0)
  if (h > 23 || mi > 59) return null
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`
}

/** "Tue 22 Sep · 14:00" (Summary / Value). */
function summary(value: string | null, time: string | null): string {
  if (!value) return 'No date'
  const d = fromKey(value)
  const wd = d.toLocaleDateString(undefined, { weekday: 'short' })
  const mon = d.toLocaleDateString(undefined, { month: 'short' })
  const day = `${wd} ${d.getDate()} ${mon}`
  return time ? `${day} · ${time.replace(/^0/, '')}` : day
}

/**
 * Date Picker (QjrFy), as drawn in "Todos - Date picker" (xOQhj). Rendered
 * `position: fixed` in a portal from the anchor's rect rather than inside the
 * list, so it can open from an item near the bottom of the window without
 * being clipped by the scrolling body. The window grows to 640 while it is
 * open, so from the composer (`below`) it always sits under it, as designed;
 * from an item it flips upward only when even the grown window has no room.
 * `dx`/`dy` offset it from the anchor's bottom-left corner.
 * Must be the direct child of an AnimatePresence.
 */
export default function DatePicker({ anchor, value, time, synced = false, dx = 0, dy = 6, below = false, onChange, onClose }: {
  anchor: HTMLElement
  value: string | null
  time: string | null
  /** Shows "On your calendar" in the summary. */
  synced?: boolean
  dx?: number
  dy?: number
  /** Never flip above the anchor. */
  below?: boolean
  onChange: (v: string | null, time: string | null) => void
  onClose: () => void
}): React.JSX.Element {
  const [timeDraft, setTimeDraft] = useState(time ?? '')
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const initial = value ? fromKey(value) : today
  const [nav, setNav] = useState({ month: new Date(initial.getFullYear(), initial.getMonth(), 1), dir: 1, instant: false })
  const month = nav.month
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<Place | null>(null)
  const inert = useExitInert()
  const group = useId()
  const clicks = useRef<number[]>([])
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The pick shows at once; the store's answer follows through `value`.
  const [sel, setSel] = useState(value)
  useEffect(() => { setSel(value) }, [value])

  useEffect(() => { setTimeDraft(time ?? '') }, [time])
  useEffect(() => holdWindow(), [])
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current) }, [])

  // Measured, so a five- or six-week month flips at the right point.
  useLayoutEffect(() => {
    const place = (): void => {
      const r = anchor.getBoundingClientRect()
      const h = ref.current?.offsetHeight ?? 0
      // The room the window has once main has grown it (the resize lands a frame or two later).
      const room = Math.max(window.innerHeight, PICKER_WINDOW_H)
      const under = r.bottom + dy
      const over = r.top - dy - h
      const left = Math.max(8, Math.min(r.left + dx, window.innerWidth - PICKER_W - 8))
      // Below when it fits, else above when that fits; when neither does, the
      // roomier side, pushed only as far as the window edge.
      let top = under
      let flipped = false
      if (!below && under + h > room - 8) {
        if (over >= 8) { top = over; flipped = true }
        else if (room - r.bottom >= r.top) top = Math.max(8, room - h - 8)
        else { top = 8; flipped = true }
      }
      const origin = `${Math.round(r.left - left)}px ${flipped ? '100%' : '0%'}`
      setPos((p) => (p && p.top === top && p.left === left && p.flipped === flipped ? p : { top, left, flipped, origin }))
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [anchor, dx, dy, below, month])

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (ref.current?.contains(t) || anchor.contains(t)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [anchor, onClose])

  // The selection circle flies inside a month and pops when it had nowhere to come from.
  const inMonth = (k: string | null): boolean => !!k && fromKey(k).getFullYear() === month.getFullYear() && fromKey(k).getMonth() === month.getMonth()
  const prevSel = useRef(sel)
  const pop = useRef(false)
  if (prevSel.current !== sel) { pop.current = !inMonth(prevSel.current); prevSel.current = sel }

  /** More than 2 clicks inside `hold.spamWindow`: swap instantly until the clicking stops. */
  const go = (dir: 1 | -1): void => {
    const now = performance.now()
    clicks.current = [...clicks.current.filter((t) => now - t < HOLD.spamWindow), now]
    pop.current = false
    setNav((n) => ({ month: new Date(n.month.getFullYear(), n.month.getMonth() + dir, 1), dir, instant: clicks.current.length > 2 }))
  }

  // Picking a day keeps the time; picking a time keeps the day (defaulting to today).
  const pick = (d: Date | null): void => {
    setSel(d ? toKey(d) : null)
    onChange(d ? toKey(d) : null, d ? time : null)
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(onClose, HOLD.pickClose)   // the selection shows first (§4.12)
  }
  const pickTime = (t: string | null): void => {
    onChange(sel ?? toKey(today), t)
    setSel((s) => s ?? toKey(today))
    setTimeDraft(t ?? '')
  }
  const commitDraft = (): void => {
    const t = timeDraft.trim() ? parseTime(timeDraft) : null
    if (timeDraft.trim() && !t) { setTimeDraft(time ?? ''); return }
    if (t === time) return
    pickTime(t)
  }

  // Monday-first grid, split into Week rows like the design.
  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  const lead = (first.getDay() + 6) % 7
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
  const cells: (Date | null)[] = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => new Date(month.getFullYear(), month.getMonth(), i + 1))]
  while (cells.length % 7) cells.push(null)
  const weeks: (Date | null)[][] = []
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))

  const quick: [string, Date | null][] = [['Today', today], ['Tomorrow', addDays(today, 1)], ['Next week', addDays(today, 7)], ['No date', null]]
  const isSel = (d: Date | null): boolean => !!d && !!sel && toKey(d) === sel
  const todayKey = toKey(today)
  const monthKey = `${month.getFullYear()}-${month.getMonth()}`

  return (
    <LayoutGroup id={group}>
      <m.div
        ref={ref}
        className="picker"
        inert={inert.inert}
        style={{
          top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? undefined : 'hidden',
          transformOrigin: pos?.origin, ...inert.style
        }}
        variants={PICKER}
        custom={!!pos?.flipped}
        initial="initial"
        animate={pos ? 'animate' : 'initial'}
        exit="exit"
      >
        <div className="picker__summary">
          <div className="picker__summary-text">
            <span className="picker__label">DUE</span>
            <span className="picker__value">{summary(sel, sel ? time : null)}</span>
          </div>
          {synced && sel && (
            <div className="picker__cal">
              <span className="picker__dot" />
              <span className="picker__cal-label">On your calendar</span>
            </div>
          )}
        </div>
        <div className="picker__quick">
          {quick.map(([label, d]) => (
            <button
              key={label}
              type="button"
              className={`picker__q ${d ? (isSel(d) ? 'is-on' : '') : (!sel ? 'is-on' : '')}`}
              onClick={() => pick(d)}
            >{label}</button>
          ))}
        </div>
        <div className="picker__month">
          <button type="button" className="picker__nav" aria-label="Previous month" onClick={() => go(-1)}>
            <Icon name="chevron-left" />
          </button>
          <BlurWords variant="label" className="picker__month-label" text={month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })} />
          <button type="button" className="picker__nav" aria-label="Next month" onClick={() => go(1)}>
            <Icon name="chevron-right" />
          </button>
        </div>
        <div className="picker__dow">{['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => <span key={i}>{d}</span>)}</div>
        <PresenceSwap swapKey={monthKey} variants={MONTH} custom={{ dir: nav.dir, instant: nav.instant }} className="picker__days">
          {weeks.map((w, wi) => (
            <div key={wi} className="picker__week">
              {w.map((d, i) => d ? (
                <button
                  key={i}
                  type="button"
                  className={`picker__day ${isSel(d) ? 'is-sel' : ''} ${toKey(d) === todayKey ? 'is-today' : ''} ${d < today ? 'is-past' : ''}`}
                  onClick={() => pick(d)}
                >
                  {isSel(d) && (
                    <m.span
                      layoutId="dp-selected"
                      layoutDependency={sel}
                      className="picker__sel"
                      aria-hidden="true"
                      transition={{ layout: SPRING.snappy }}
                      variants={presets.popIn}
                      initial={pop.current ? 'initial' : false}
                      animate="animate"
                    />
                  )}
                  <span className="picker__num">{d.getDate()}</span>
                </button>
              ) : <span key={i} className="picker__day picker__day--blank" />)}
            </div>
          ))}
        </PresenceSwap>
        <div className="picker__sep" />
        <div className="picker__time">
          <Icon name="clock" />
          {QUICK_TIMES.map((t) => {
            const key = parseTime(t)!
            return (
              <button key={t} type="button" className={`picker__t ${time === key ? 'is-on' : ''}`} onClick={() => pickTime(time === key ? null : key)}>{t}</button>
            )
          })}
          <input
            className="picker__timefield"
            placeholder="hh:mm"
            value={timeDraft}
            onChange={(e) => setTimeDraft(e.target.value)}
            onBlur={commitDraft}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitDraft() } }}
          />
        </div>
      </m.div>
    </LayoutGroup>
  )
}
