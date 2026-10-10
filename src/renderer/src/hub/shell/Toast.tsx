import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, m } from 'motion/react'
import { Icon } from '../../shared/icons'
import { HOLD, presets, useExitInert } from '../../shared/motion'
import { onToast } from './toastBus'
import './toast.css'

type ToastState = { id: number; message: string; replace: boolean }

/**
 * Hub toast layer, bottom centre (docs/MOTION.md §4.10). One toast at a time:
 * a new one pushes the old one out upward. The `hold.notice` countdown stops
 * while the toast is hovered or focused, and while the window is blurred or
 * hidden, then carries on with the time that was left.
 */
export default function ToastHost(): React.JSX.Element {
  const [toast, setToast] = useState<ToastState | null>(null)
  // How the toast on screen leaves: pushed out by a new one, or timed out.
  const [exitMode, setExitMode] = useState<'replace' | undefined>(undefined)
  const [held, setHeld] = useState({ hover: false, focus: false, away: false })
  const seq = useRef(0)
  const showing = useRef(false)
  const left = useRef<{ id: number; ms: number }>({ id: 0, ms: HOLD.notice })

  useEffect(() => onToast((message) => {
    const replace = showing.current
    showing.current = true
    setExitMode(replace ? 'replace' : undefined)
    setToast({ id: ++seq.current, message, replace })
    setHeld((h) => ({ ...h, hover: false, focus: false }))
  }), [])

  useEffect(() => {
    const sync = (): void => {
      const away = document.visibilityState !== 'visible' || !document.hasFocus()
      setHeld((h) => (h.away === away ? h : { ...h, away }))
    }
    sync()
    window.addEventListener('focus', sync)
    window.addEventListener('blur', sync)
    document.addEventListener('visibilitychange', sync)
    return () => {
      window.removeEventListener('focus', sync)
      window.removeEventListener('blur', sync)
      document.removeEventListener('visibilitychange', sync)
    }
  }, [])

  const paused = held.hover || held.focus || held.away
  const id = toast?.id
  useEffect(() => {
    if (id === undefined || paused) return
    if (left.current.id !== id) left.current = { id, ms: HOLD.notice }
    const run = left.current
    const started = performance.now()
    const t = setTimeout(() => { showing.current = false; setExitMode(undefined); setToast(null) }, run.ms)
    return () => { clearTimeout(t); run.ms = Math.max(0, run.ms - (performance.now() - started)) }
  }, [id, paused])

  return (
    <div className="toast-layer" role="status" aria-live="polite">
      <AnimatePresence custom={exitMode}>
        {toast && (
          <ToastItem
            key={toast.id}
            message={toast.message}
            replace={toast.replace}
            onHover={(hover) => setHeld((h) => ({ ...h, hover }))}
            onFocus={(focus) => setHeld((h) => ({ ...h, focus }))}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

/** "Toast" (pBsOO): check 16 in $success, then the message. */
function ToastItem({ message, replace, onHover, onFocus }: {
  message: string
  replace: boolean
  onHover: (on: boolean) => void
  onFocus: (on: boolean) => void
}): React.JSX.Element {
  const inert = useExitInert()
  return (
    <m.div
      className="toast"
      inert={inert.inert}
      style={inert.style}
      variants={presets.toast}
      custom={replace ? 'replace' : undefined}
      initial="initial"
      animate="animate"
      exit="exit"
      onPointerEnter={() => onHover(true)}
      onPointerLeave={() => onHover(false)}
      onFocus={() => onFocus(true)}
      onBlur={() => onFocus(false)}
    >
      <Icon name="check" active className="toast__icon" />
      <span className="toast__msg">{message}</span>
    </m.div>
  )
}
