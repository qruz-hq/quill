import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, m } from 'motion/react'
import { Icon } from '../../shared/icons'
import { PRESET, SPRING, useExitInert } from '../../shared/motion'
import type { SelectOption } from '../../shared/ui'

/* Settings controls with the motion of docs/MOTION.md §4.7. Same nodes and
   props as the shared Toggle and Select, so a pane swaps the import only. */

/* "Toggle / Off" (qKcSg), "Toggle / On" (HQZBU): track 44, padding 3, knob 20. */
const KNOB = 20
const KNOB_PRESSED = 24
const TRAVEL = 44 - 2 * 3 - KNOB

/**
 * Knob x on `spring.snappy`. While the pointer is down the knob stretches to
 * 24 toward the side it is about to travel to (`spring.snap`); Space toggles
 * with the knob spring alone.
 */
export function Toggle({ on, disabled, onChange, label, className }: {
  on: boolean; disabled?: boolean; onChange: (v: boolean) => void
  /** Accessible name when no visible label is associated. */
  label?: string; className?: string
}): React.JSX.Element {
  const [pressed, setPressed] = useState(false)
  const width = pressed ? KNOB_PRESSED : KNOB
  return (
    <button
      type="button"
      className={['set-toggle', on && 'is-on', className].filter(Boolean).join(' ')}
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      onPointerDown={() => setPressed(true)}
      onPointerUp={() => setPressed(false)}
      onPointerLeave={() => setPressed(false)}
      onPointerCancel={() => setPressed(false)}
    >
      <m.span
        className="set-toggle__knob"
        initial={false}
        animate={{ x: on ? TRAVEL - (width - KNOB) : 0, width }}
        transition={{ x: SPRING.snappy, width: SPRING.snap }}
      />
    </button>
  )
}

type Place = { left: number; top: number; width: number; maxHeight: number; origin: string }
const MARGIN = 8

/**
 * "Select" (C5tli). Opens in place: the list is laid so the selected row sits
 * exactly over the trigger, clamped 8 inside the window, and scales from that
 * row's centre. Rows never stagger and the highlight moves instantly.
 */
export function Select({ value, options, onChange, disabled, label, className, style }: {
  value: string; options: SelectOption[]; onChange: (v: string) => void
  disabled?: boolean; label?: string; className?: string; style?: CSSProperties
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [hi, setHi] = useState(0)
  const [place, setPlace] = useState<Place | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const current = options.find((o) => o.value === value)
  const selected = Math.max(0, options.findIndex((o) => o.value === value))

  const show = (): void => {
    if (disabled || !options.length) return
    setHi(selected)
    setPlace(null)
    setOpen(true)
  }
  // Focus goes back to the trigger at t = 0, before the list has faded.
  const close = (refocus = true): void => {
    setOpen(false)
    if (refocus) trigger.current?.focus({ preventScroll: true })
  }
  const pick = (o: SelectOption): void => {
    if (o.disabled) return
    close()
    if (o.value !== value) onChange(o.value)
  }
  const step = (from: number, by: number): number => {
    for (let i = from + by; i >= 0 && i < options.length; i += by) if (!options[i].disabled) return i
    return from
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={['q-select', 'set-select', disabled && 'is-disabled', className].filter(Boolean).join(' ')}
        style={style}
        disabled={disabled}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onClick={() => (open ? close() : show())}
        onKeyDown={(e) => {
          if (open) return
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); show() }
        }}
      >
        <span className="q-select__value">{current?.label ?? ''}</span>
        <Icon name="chevron-down" className="q-select__chev" />
      </button>
      {createPortal(
        <AnimatePresence>
          {open && (
            <SelectList
              key="list"
              label={label}
              options={options}
              selected={selected}
              hi={hi}
              place={place}
              trigger={trigger}
              onPlace={setPlace}
              onHi={setHi}
              onPick={pick}
              onStep={(by) => setHi((h) => step(h, by))}
              onEdge={(end) => setHi(end ? step(options.length, -1) : step(-1, 1))}
              onClose={close}
            />
          )}
        </AnimatePresence>,
        document.body
      )}
    </>
  )
}

function SelectList({ label, options, selected, hi, place, trigger, onPlace, onHi, onPick, onStep, onEdge, onClose }: {
  label?: string; options: SelectOption[]; selected: number; hi: number; place: Place | null
  trigger: React.RefObject<HTMLButtonElement | null>
  onPlace: (p: Place) => void; onHi: (i: number) => void; onPick: (o: SelectOption) => void
  onStep: (by: number) => void; onEdge: (end: boolean) => void; onClose: (refocus?: boolean) => void
}): React.JSX.Element {
  const list = useRef<HTMLDivElement>(null)
  const inert = useExitInert()

  // Measure before paint: the selected row lands on the trigger's own box.
  useLayoutEffect(() => {
    const el = list.current
    const t = trigger.current?.getBoundingClientRect()
    if (!el || !t || place) return
    const row = el.children[selected] as HTMLElement | undefined
    const rowTop = row?.offsetTop ?? 0
    const rowH = row?.offsetHeight ?? t.height
    const maxHeight = window.innerHeight - 2 * MARGIN
    const height = Math.min(el.scrollHeight, maxHeight)
    const top = Math.min(Math.max(t.top - rowTop, MARGIN), window.innerHeight - MARGIN - height)
    const width = Math.max(t.width, el.offsetWidth)
    const left = Math.min(Math.max(t.left, MARGIN), window.innerWidth - MARGIN - width)
    const originY = Math.min(Math.max(t.top + rowH / 2 - top, 0), height)
    onPlace({ left, top, width, maxHeight, origin: `${t.width / 2}px ${originY}px` })
  })

  useEffect(() => {
    if (!place) return
    const el = list.current
    el?.focus({ preventScroll: true })
    const row = el?.children[selected] as HTMLElement | undefined
    if (el && row && el.scrollHeight > el.clientHeight) el.scrollTop = row.offsetTop - (el.clientHeight - row.offsetHeight) / 2
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!place])

  useEffect(() => {
    const away = (e: PointerEvent): void => {
      const n = e.target as Node
      if (list.current?.contains(n) || trigger.current?.contains(n)) return
      onClose(false)   // focus goes where the user clicked
    }
    const gone = (): void => onClose(false)
    document.addEventListener('pointerdown', away, true)
    window.addEventListener('resize', gone)
    window.addEventListener('blur', gone)
    return () => {
      document.removeEventListener('pointerdown', away, true)
      window.removeEventListener('resize', gone)
      window.removeEventListener('blur', gone)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const k = e.key
    if (k === 'Tab') { onClose(); return }
    if (!['Escape', 'Enter', ' ', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(k)) return
    // Escape must not reach Settings, which would leave the route.
    e.preventDefault()
    e.stopPropagation()
    if (k === 'Escape') onClose()
    else if (k === 'Enter' || k === ' ') onPick(options[hi])
    else if (k === 'ArrowDown') onStep(1)
    else if (k === 'ArrowUp') onStep(-1)
    else onEdge(k === 'End')
  }

  return (
    <m.div
      ref={list}
      className="set-menu"
      role="listbox"
      aria-label={label}
      aria-activedescendant={`set-opt-${hi}`}
      tabIndex={-1}
      inert={inert.inert}
      variants={PRESET.selectInPlace}
      initial="initial"
      animate={place ? 'animate' : 'initial'}
      exit="exit"
      style={{
        left: place?.left ?? 0, top: place?.top ?? 0, minWidth: place?.width ?? trigger.current?.offsetWidth,
        maxHeight: place?.maxHeight, transformOrigin: place?.origin, visibility: place ? 'visible' : 'hidden',
        ...inert.style
      }}
      onKeyDown={onKeyDown}
    >
      {options.map((o, i) => (
        <div
          key={o.value}
          id={`set-opt-${i}`}
          role="option"
          aria-selected={i === selected}
          aria-disabled={o.disabled || undefined}
          className={['set-menu__row', i === hi && 'is-hi', i === selected && 'is-selected', o.disabled && 'is-disabled'].filter(Boolean).join(' ')}
          onPointerMove={() => { if (!o.disabled && i !== hi) onHi(i) }}
          onClick={() => onPick(o)}
        >
          <span className="set-menu__label">{o.label}</span>
          {i === selected && <Icon name="check" className="set-menu__check" />}
        </div>
      ))}
    </m.div>
  )
}
