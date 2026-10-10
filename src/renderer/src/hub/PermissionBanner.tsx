import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { AnimatePresence, m } from 'motion/react'
import { Banner, Button, type BannerTone } from '../shared/ui'
import type { IconName } from '../shared/icons'
import {
  BlurWords, DUR_MS, HOLD, RING, RealHeight, SCALE, SPRING, presets, springToLinear, tween,
  useDocumentVisible, useExitInert
} from '../shared/motion'
import './permission-banner.css'

/* "Banner Slot" (ePPbx / FZG9v) between the title bar and the bento, with the
   permission banner motion of docs/MOTION.md §4.5: real height in and out, a
   block swap between the two variants, and a success beat when the permission
   the banner asks for is granted. */

type Kind = 'mic' | 'ax'

const COPY: Record<Kind, { tone: BannerTone; icon: IconName; message: string }> = {
  mic: { tone: 'error', icon: 'microphone', message: 'Quill can’t use the microphone, so dictation won’t record.' },
  ax: {
    tone: 'neutral', icon: 'accessibility',
    message: 'Accessibility is off: the hold key is inactive and dictations are copied instead of typed.'
  }
}

/** The check lands over `dur.base`, then holds `hold.bannerSuccess`; the banner leaves at t = 600. */
const SUCCESS_MS = DUR_MS.base + HOLD.bannerSuccess
/** §3.6: a grant seen while the hub was hidden plays 100 ms after it is visible again. */
const VISIBLE_DEFER_MS = DUR_MS.micro
/** Banner TyR7q gap: the ghost button's wrapper gives it back while it is collapsed. */
const BANNER_GAP = 12

const pop = springToLinear(SPRING.snappy)
/* The shared Banner renders its own icon chip, so the check pop and the ring
   are CSS keyframes fed by the tokens. */
const SUCCESS_VARS = {
  '--perm-pop-from': SCALE.pop,
  '--perm-pop-dur': `${pop.duration}ms`,
  '--perm-pop-ease': pop.easing,
  '--perm-ring-scale': RING.default.scale[1],
  '--perm-ring-from': RING.default.opacity[0],
  '--perm-ring-dur': `${RING.default.duration * 1000}ms`
} as CSSProperties

/* ---- What the bento needs to know: rows are shorter under a banner ---- */
type BannerState = { open: boolean; live: boolean }
let state: BannerState = { open: false, live: false }
const listeners = new Set<() => void>()
function publish(patch: Partial<BannerState>): void {
  if ((patch.open ?? state.open) === state.open && (patch.live ?? state.live) === state.live) return
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}
const subscribe = (cb: () => void): (() => void) => { listeners.add(cb); return () => listeners.delete(cb) }
const snapshot = (): BannerState => state

/**
 * `open` flips at t = 0 of the banner coming in or leaving, so the bento
 * reflows with the height spring. `live` is false until the launch state has
 * been painted: a banner present at first render is at rest.
 */
export function useBanner(): BannerState {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

export default function PermissionBanner({ perms, suppressed, axDismissed, onFix, onNotNow }: {
  perms: FlowPerms | null
  /** The permissions screen is up: no banner under it. */
  suppressed: boolean
  axDismissed: boolean
  onFix: () => void
  onNotNow: () => void
}): React.JSX.Element | null {
  const micMissing = !!perms && perms.mic !== 'granted' && perms.mic !== 'unknown'
  const axMissing = !!perms && !perms.ax
  const want: Kind | null = suppressed ? null : micMissing ? 'mic' : axMissing && !axDismissed ? 'ax' : null
  const visible = useDocumentVisible()

  const [shown, setShown] = useState<Kind | null>(null)
  const [granted, setGranted] = useState(false)
  // The launch state is adopted during render, so a banner due at first render mounts at rest.
  const [booted, setBooted] = useState(false)
  if (!booted && perms) { setBooted(true); setShown(want) }

  const wantRef = useRef(want)
  wantRef.current = want
  const deferred = useRef(false)

  useEffect(() => {
    if (!booted || granted || shown === want) return
    // Leaving because its own permission arrived (not Fix, not "Not now"): the success beat first.
    const earned = shown !== null && !suppressed && (shown === 'mic' ? !micMissing : !axMissing)
    if (!earned) { setShown(want); return }
    if (!visible) { deferred.current = true; return }
    const t = setTimeout(() => { deferred.current = false; setGranted(true) }, deferred.current ? VISIBLE_DEFER_MS : 0)
    return () => clearTimeout(t)
  }, [booted, granted, shown, want, suppressed, micMissing, axMissing, visible])

  useEffect(() => {
    if (!granted) return
    const t = setTimeout(() => { setGranted(false); setShown(wantRef.current) }, SUCCESS_MS)
    return () => clearTimeout(t)
  }, [granted])

  const open = shown !== null
  useLayoutEffect(() => { publish({ open }) }, [open])
  useEffect(() => {
    if (!booted) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const raf = requestAnimationFrame(() => { timer = setTimeout(() => publish({ live: true }), 0) })
    return () => { cancelAnimationFrame(raf); clearTimeout(timer) }
  }, [booted])
  useEffect(() => () => publish({ open: false }), [])

  if (!booted) return null
  const copy = shown ? COPY[shown] : null

  return (
    <RealHeight open={open} content={presets.bannerContent} style={{ flex: 'none' }}>
      {copy && (
        <div className="shell__banner perm-banner">
          <Banner
            tone={copy.tone}
            icon={granted ? 'check' : copy.icon}
            className={granted ? 'is-granted' : undefined}
            style={SUCCESS_VARS}
            actions={
              <>
                <Button size="sm" onClick={onFix}>Fix</Button>
                <AnimatePresence initial={false}>
                  {shown === 'ax' && <NotNow key="not-now" onClick={onNotNow} />}
                </AnimatePresence>
              </>
            }
          >
            <BlurWords variant="block" initial={false} text={copy.message} />
          </Banner>
        </div>
      )}
    </RealHeight>
  )
}

/* "Not now" only exists on the Accessibility variant: its real width opens and
   closes with `spring.ui` on a variant change, so the message is never jumped. */
function NotNow({ onClick }: { onClick: () => void }): React.JSX.Element {
  const inert = useExitInert()
  const [settled, setSettled] = useState(true)
  const closed = { width: 0, marginLeft: -BANNER_GAP, opacity: 0 }
  return (
    <m.span
      className="perm-banner__extra"
      inert={inert.inert}
      style={{ overflow: settled && !inert.inert ? undefined : 'hidden', ...inert.style }}
      initial={closed}
      animate={{ width: 'auto', marginLeft: 0, opacity: 1, transition: { default: SPRING.ui, opacity: tween('fast') } }}
      exit={{ ...closed, transition: { default: SPRING.ui, opacity: tween('flash', 'exit') } }}
      onAnimationStart={() => setSettled(false)}
      onAnimationComplete={() => setSettled(true)}
    >
      <Button size="sm" variant="ghost" onClick={onClick}>Not now</Button>
    </m.span>
  )
}
