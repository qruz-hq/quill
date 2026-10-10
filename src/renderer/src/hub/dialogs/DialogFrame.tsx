import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { m, useIsPresent } from 'motion/react'
import { Icon } from '../../shared/icons'
import { Keycap } from '../../shared/ui'
import { BlurWords, SPRING, presets, useReduceMotion } from '../../shared/motion'
import { MORPH_SETTLE } from '../sniptfMotion'
import './dialog.css'

export type DialogAccent = 'pink' | 'lime' | 'violet' | 'cyan' | 'tangerine'

/** How the dialog enters and leaves (docs/MOTION.md §4.8). */
export interface DialogMotion {
  /** The trigger's centre in viewport px: the dialog scales from it. */
  origin?: { x: number; y: number } | null
  /** Container transform: the card with this `layoutId` morphs into the dialog and back. */
  morphId?: string
}

const Settled = createContext(true)
/**
 * False while a card is still morphing into this dialog. Layout nodes inside
 * the dialog (selection indicators) wait for it: projected on their own while
 * their parent is mid-morph, they would sit apart from the content around them.
 */
export const useDialogSettled = (): boolean => useContext(Settled)

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Keeps Tab and Shift+Tab inside the dialog: past the last control it goes to
 * the first, and back. Focus that sits in a popover the dialog opened (a
 * select's list, portaled to the body) is left to that popover.
 */
function trapTab(e: KeyboardEvent, dlg: HTMLElement): void {
  const items = Array.from(dlg.querySelectorAll<HTMLElement>(FOCUSABLE))
    .filter((el) => el.getClientRects().length > 0 && !el.closest('[inert]'))
  if (!items.length) { e.preventDefault(); return }
  const first = items[0]
  const last = items[items.length - 1]
  const at = document.activeElement
  const inside = !!at && dlg.contains(at)
  if (!inside && at && at !== document.body) return
  if (e.shiftKey ? (!inside || at === first) : (!inside || at === last)) {
    e.preventDefault()
    ;(e.shiftKey ? last : first).focus()
  }
}

/* $radius-xl as a number: Motion only scale-corrects a px radius set in `style`. */
const RADIUS_XL = 32

/**
 * The dialog frame (VnBia / ddCUn / OWYl9): an accent hero tile on top,
 * the dialog's own tiles, then the footer. Escape and a backdrop click close;
 * ⌘↩ submits; Tab stays inside. Render it inside an `AnimatePresence`: it goes inert on its
 * first exit frame and stops listening to the keyboard.
 */
export function DialogFrame({ accent, wide, label, headline, lead, children, footer, onClose, onSubmit, motion }: {
  accent: DialogAccent
  wide?: boolean
  label: string
  headline: string
  /** The hero's last row ("Example" or "Shortcut"). */
  lead: ReactNode
  children: ReactNode
  footer: ReactNode
  onClose: () => void
  onSubmit?: () => void
  motion?: DialogMotion
}): React.JSX.Element {
  const present = useIsPresent()
  const reduced = useReduceMotion()
  const [morphed, setMorphed] = useState(false)
  const dlg = useRef<HTMLDivElement>(null)
  const morphId = motion?.morphId
  const origin = motion?.origin

  useEffect(() => {
    if (!present) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
      else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && onSubmit) { e.preventDefault(); onSubmit() }
      else if (e.key === 'Tab' && dlg.current) trapTab(e, dlg.current)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [present, onClose, onSubmit])

  // Scale from the trigger's centre. offsetLeft/Top ignore the entrance transform.
  useLayoutEffect(() => {
    const el = dlg.current
    if (!el || morphId || !origin) return
    const host = el.offsetParent?.getBoundingClientRect()
    el.style.transformOrigin = `${origin.x - (host?.left ?? 0) - el.offsetLeft}px ${origin.y - (host?.top ?? 0) - el.offsetTop}px`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const cls = ['dlg', `dlg--${accent}`, wide && 'dlg--wide'].filter(Boolean).join(' ')
  const body = (
    <Settled.Provider value={!morphId || morphed || reduced}>
      <div className="dlg__hero">
        <div className="dlg__top">
          <span className="dlg__label">{label}</span>
          <m.button
            type="button"
            className="dlg__close"
            aria-label="Close"
            title="Close"
            onClick={onClose}
            {...presets.press('icon')}
          >
            <Icon name="close" size={16} />
          </m.button>
        </div>
        {/* A morph reveals the title with the rest of the content, as one unit. */}
        {morphId
          ? <h2 className="dlg__headline">{headline}</h2>
          : <BlurWords as="h2" className="dlg__headline" variant="titleUnit" initial text={headline} />}
        {lead}
      </div>
      {children}
      <div className="dlg__footer">{footer}</div>
    </Settled.Provider>
  )

  return createPortal(
    <div className="dlg-overlay" inert={!present} style={present ? undefined : { pointerEvents: 'none' }}>
      <m.div
        className="dlg-scrim"
        variants={presets.dialog.scrim}
        initial="initial"
        animate="animate"
        exit="exit"
        onMouseDown={onClose}
      />
      {morphId ? (
        <m.div
          ref={dlg}
          className={cls}
          role="dialog"
          aria-modal="true"
          aria-label={headline}
          layoutId={morphId}
          layoutDependency={present}
          layoutCrossfade={false}
          layoutScroll
          transition={{ layout: { ...SPRING.morph, ...MORPH_SETTLE } }}
          onLayoutAnimationComplete={() => setMorphed(true)}
          style={{ borderRadius: RADIUS_XL }}
        >
          <m.div className="dlg__content" variants={presets.morphContent} initial="initial" animate="animate" exit="exit">
            {body}
          </m.div>
        </m.div>
      ) : (
        <m.div
          ref={dlg}
          className={cls}
          role="dialog"
          aria-modal="true"
          aria-label={headline}
          layoutScroll
          variants={presets.dialog.content}
          initial="initial"
          animate="animate"
          exit="exit"
        >
          <div className="dlg__content">{body}</div>
        </m.div>
      )}
    </div>,
    document.body
  )
}

/** Footer "Hint": esc keycap + "to cancel". */
export function EscHint(): React.JSX.Element {
  return (
    <div className="dlg__esc">
      <Keycap size="sm">esc</Keycap>
      <span className="dlg__esc-text">to cancel</span>
    </div>
  )
}
