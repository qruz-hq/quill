import { useEffect, useLayoutEffect, useRef, useState } from 'react'

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

const PICKER_H = 344
const QUICK_TIMES = ['9:00', '12:00', '14:00', '17:00']

/** Accepts 9, 9:5, 09:05, 9.30 -> "09:05"; anything else -> null. */
export function parseTime(raw: string): string | null {
  const m = /^\s*(\d{1,2})(?:[:.h](\d{1,2}))?\s*$/.exec(raw)
  if (!m) return null
  const h = Number(m[1]), mi = Number(m[2] ?? 0)
  if (h > 23 || mi > 59) return null
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`
}

/**
 * Quick picks over a month grid. Rendered `position: fixed` from the anchor's
 * rect rather than inside the list, so it can open from an item near the
 * bottom of the window without being clipped by the scrolling body — it flips
 * upward when there is no room below.
 */
export default function DatePicker({ anchor, value, time, onChange, onClose }: {
  anchor: HTMLElement
  value: string | null
  time: string | null
  onChange: (v: string | null, time: string | null) => void
  onClose: () => void
}): React.JSX.Element {
  const [timeDraft, setTimeDraft] = useState(time ?? '')
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const initial = value ? fromKey(value) : today
  const [month, setMonth] = useState(new Date(initial.getFullYear(), initial.getMonth(), 1))
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 })

  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect()
    const below = r.bottom + 6
    const fits = below + PICKER_H <= window.innerHeight - 8
    setPos({ top: fits ? below : Math.max(8, r.top - 6 - PICKER_H), left: Math.min(r.left, window.innerWidth - 300 - 8) })
  }, [anchor])

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

  // Picking a day keeps the time; picking a time keeps the day (defaulting to today).
  const pick = (d: Date | null): void => { onChange(d ? toKey(d) : null, d ? time : null); onClose() }
  const pickTime = (t: string | null): void => {
    onChange(value ?? toKey(today), t)
    setTimeDraft(t ?? '')
  }
  const commitDraft = (): void => {
    const t = timeDraft.trim() ? parseTime(timeDraft) : null
    if (timeDraft.trim() && !t) { setTimeDraft(time ?? ''); return }
    pickTime(t)
  }

  // Monday-first grid, like the design.
  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  const lead = (first.getDay() + 6) % 7
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
  const cells: (Date | null)[] = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => new Date(month.getFullYear(), month.getMonth(), i + 1))]
  while (cells.length % 7) cells.push(null)

  const quick: [string, Date | null][] = [['Today', today], ['Tomorrow', addDays(today, 1)], ['Next week', addDays(today, 7)], ['No date', null]]
  const isSel = (d: Date | null): boolean => !!d && !!value && toKey(d) === value

  return (
    <div ref={ref} className="picker" style={{ top: pos.top, left: pos.left }}>
      <div className="picker__quick">
        {quick.map(([label, d]) => (
          <button
            key={label}
            className={`picker__q ${d ? (isSel(d) ? 'is-on' : '') : (!value ? 'is-on' : '')}`}
            onClick={() => pick(d)}
          >{label}</button>
        ))}
      </div>
      <div className="picker__month">
        <button className="picker__nav" aria-label="Previous month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>‹</button>
        <span>{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>
        <button className="picker__nav" aria-label="Next month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>›</button>
      </div>
      <div className="picker__dow">{['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => <span key={i}>{d}</span>)}</div>
      <div className="picker__grid">
        {cells.map((d, i) => d ? (
          <button
            key={i}
            className={`picker__day ${isSel(d) ? 'is-sel' : ''} ${toKey(d) === toKey(today) ? 'is-today' : ''} ${d < today ? 'is-past' : ''}`}
            onClick={() => pick(d)}
          >{d.getDate()}</button>
        ) : <span key={i} />)}
      </div>
      <div className="picker__sep" />
      <div className="picker__time">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
        {QUICK_TIMES.map((t) => {
          const key = parseTime(t)!
          return (
            <button key={t} className={`picker__q ${time === key ? 'is-on' : ''}`} onClick={() => pickTime(time === key ? null : key)}>{t}</button>
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
    </div>
  )
}
